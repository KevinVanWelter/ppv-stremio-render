const express = require('express');
const puppeteer = require('puppeteer');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 10000;
const SCRAPE_INTERVAL = 90 * 1000;

function getPublicUrl() {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  if (process.env.RENDER === 'true') {
    const serviceName = process.env.RENDER_SERVICE_NAME || 'ppv-stremio-render';
    return `https://${serviceName}.onrender.com`;
  }
  return `http://localhost:${PORT}`;
}

const PUBLIC_URL = getPublicUrl();
console.log('🔗 PUBLIC_URL set to:', PUBLIC_URL);

// ============================================================================
// STATE
// ============================================================================

let cachedStreams = [];
let lastScrapeTime = null;
let isScraping = false;

// Persistent stream mapping
const streamMapping = new Map();

function generateStreamId(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

// ============================================================================
// SCRAPER
// ============================================================================

async function scrapePPVLiveStreams() {
  let browser;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions'
      ],
      timeout: 30000
    });
    
    const page = await browser.newPage();
    
    page.on('popup', async popup => {
      await popup.close();
    });
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('🏠 Navigating to ppv.to...');
    
    await page.goto('https://ppv.to/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    }).catch(() => {});
    
    console.log('✅ PPV.to loaded');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('🔍 Scraping live games...');
    
    const liveEvents = await page.evaluate(() => {
      const events = [];
      let liveNowElement = null;
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        const lowerText = text.toLowerCase();
        
        if (!liveNowElement && (
          lowerText === 'live now' || 
          lowerText === 'live' ||
          lowerText.includes('live now') ||
          (el.innerHTML && el.innerHTML.includes('🔴'))
        )) {
          liveNowElement = el;
          break;
        }
      }
      
      if (!liveNowElement) {
        const liveLinks = Array.from(document.querySelectorAll('a[href*="/live/"]'));
        if (liveLinks.length > 0) {
          liveNowElement = liveLinks[0].closest('div, section');
        }
      }
      
      if (!liveNowElement) {
        return { events, error: 'Could not find Live now heading or live links' };
      }
      
      let gamesContainer = liveNowElement.parentElement;
      while (gamesContainer && !gamesContainer.querySelectorAll('a[href*="/live/"]').length) {
        gamesContainer = gamesContainer.parentElement;
      }
      
      if (!gamesContainer) {
        return { events, error: 'Could not find games container' };
      }
      
      const allGameLinks = Array.from(gamesContainer.querySelectorAll('a[href*="/live/"]'));
      const seenHrefs = new Set();
      const seenTitles = new Set();
      
      for (const link of allGameLinks) {
        const href = link.getAttribute('href') || '';
        
        if (href.includes('jump') || href.includes('category') || href === '/live/sports') {
          continue;
        }
        
        if (seenHrefs.has(href)) continue;
        
        const card = link.closest('[class*="card"], [class*="item"], div');
        if (!card) continue;
        
        const titleEl = card.querySelector('h5, h4, h3, [class*="title"]');
        let title = '';
        
        if (titleEl) {
          const allH5s = card.querySelectorAll('h5');
          title = allH5s.length > 0 ? allH5s[0].textContent.trim() : titleEl.textContent.trim();
        } else {
          title = card.textContent.trim().split('\n')[0].trim();
        }
        
        title = title.replace(/\s+/g, ' ').trim();
        if (seenTitles.has(title)) continue;
        
        const channelEl = card.querySelector('[class*="channel"], [class*="network"]');
        const channel = channelEl ? channelEl.textContent.trim() : '';
        
        if (href && title && title.length > 3) {
          seenHrefs.add(href);
          seenTitles.add(title);
          
          events.push({
            title: title,
            channel: channel,
            href: href.startsWith('http') ? href : `https://ppv.to${href}`
          });
        }
      }
      
      return { events };
    });
    
    if (liveEvents.error) {
      console.log(`⚠️  ${liveEvents.error}`);
      await browser.close();
      return [];
    }
    
    console.log(`📊 Found ${liveEvents.events.length} live events\n`);
    
    if (liveEvents.events.length === 0) {
      console.log('ℹ️  No live events found');
      await browser.close();
      return [];
    }
    
    const results = [];
    
    for (let i = 0; i < liveEvents.events.length; i++) {
      const event = liveEvents.events[i];
      console.log(`\n▶️  [${i + 1}/${liveEvents.events.length}] ${event.title}`);
      
      const eventM3u8Urls = [];
      
      const requestHandler = request => {
        const url = request.url();
        if (url.includes('.m3u8')) {
          console.log(`    📡 M3U8: ${url.substring(0, 70)}...`);
          eventM3u8Urls.push(url);
        }
      };
      
      const responseHandler = async (response) => {
        try {
          const url = response.url();
          if (url.includes('.m3u8')) {
            eventM3u8Urls.push(url);
          }
        } catch (e) {}
      };
      
      page.on('request', requestHandler);
      page.on('response', responseHandler);
      
      try {
        console.log(`    🌐 Loading: ${event.href}`);
        
        await page.goto(event.href, {
          waitUntil: 'domcontentloaded',
          timeout: 25000
        }).catch(() => console.log(`    ⚠️  Timeout (continuing)`));
        
        console.log(`    ⏱️  Waiting 15 seconds for streams...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        console.log(`    📊 Found ${eventM3u8Urls.length} m3u8 URLs so far`);
        
        if (eventM3u8Urls.length === 0) {
          console.log(`    🎬 Trying video interaction...`);
          
          const frames = page.frames();
          console.log(`    📁 Checking ${frames.length} frames`);
          
          for (let f = 0; f < Math.min(frames.length, 5); f++) {
            try {
              await frames[f].evaluate(() => {
                const video = document.querySelector('video');
                if (video) {
                  video.muted = true;
                  video.play().catch(() => {});
                }
              }).catch(() => {});
              
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              if (eventM3u8Urls.length > 0) {
                console.log(`    ✅ M3U8 found after frame ${f + 1}`);
                break;
              }
            } catch (e) {}
          }
          
          if (eventM3u8Urls.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        
        page.off('request', requestHandler);
        page.off('response', responseHandler);
        
        if (eventM3u8Urls.length > 0) {
          const uniqueUrls = [...new Set(eventM3u8Urls)];
          console.log(`    ✅ Total: ${uniqueUrls.length} unique m3u8(s)`);
          
          results.push({
            title: event.title,
            channel: event.channel,
            href: event.href,
            m3u8Urls: uniqueUrls
          });
        } else {
          console.log(`    ❌ No streams found`);
        }
        
      } catch (error) {
        console.log(`    ❌ Error: ${error.message}`);
        page.off('request', requestHandler);
        page.off('response', responseHandler);
      }
    }
    
    await browser.close();
    console.log(`\n✅ Scrape complete: ${results.length}/${liveEvents.events.length} streams\n`);
    return results;
    
  } catch (error) {
    console.error('❌ Scraping error:', error);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    return [];
  }
}

// ============================================================================
// SCHEDULER
// ============================================================================

async function runScraper() {
  if (isScraping) {
    console.log('⏭️  Scraping in progress, skipping...\n');
    return;
  }

  try {
    isScraping = true;
    console.log('\n🕷️  Starting scrape...');
    
    const results = await scrapePPVLiveStreams();
    
    cachedStreams = results.map((stream) => {
      const streamId = generateStreamId(stream.title);
      
      streamMapping.set(streamId, {
        title: stream.title,
        channel: stream.channel,
        href: stream.href,
        m3u8Urls: stream.m3u8Urls,
        lastUpdated: new Date()
      });
      
      return {
        id: streamId,
        title: stream.title,
        channel: stream.channel,
        href: stream.href,
        streamUrls: stream.m3u8Urls.map((_, idx) => 
          `${PUBLIC_URL}/stream/${streamId}/feed${idx + 1}.m3u8`
        )
      };
    });
    
    lastScrapeTime = new Date().toISOString();
    console.log(`✅ Updated cache: ${results.length} streams`);
    console.log(`⏰ Next scrape in ${SCRAPE_INTERVAL / 1000} seconds\n`);
    
  } catch (error) {
    console.error('❌ Scraping error:', error);
  } finally {
    isScraping = false;
  }
}

function startScheduler() {
  runScraper();
  setInterval(runScraper, SCRAPE_INTERVAL);
}

// ============================================================================
// PROXY
// ============================================================================

async function proxyM3u8(targetUrl, res) {
  const urlObj = new URL(targetUrl);
  const protocol = urlObj.protocol === 'https:' ? https : http;
  
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Origin': 'https://ppv.to',
      'Referer': 'https://ppv.to/'
    }
  };
  
  const proxyReq = protocol.request(options, (proxyRes) => {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const newB64 = Buffer.from(proxyRes.headers.location).toString('base64');
      return res.redirect(`/proxy/${newB64}`);
    }
    
    res.statusCode = proxyRes.statusCode;
    
    if (proxyRes.headers['content-type']) {
      res.setHeader('Content-Type', proxyRes.headers['content-type']);
    }
    if (proxyRes.headers['content-length']) {
      res.setHeader('Content-Length', proxyRes.headers['content-length']);
    }
    
    if (targetUrl.includes('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      
      let data = '';
      proxyRes.on('data', chunk => { data += chunk.toString('utf8'); });
      proxyRes.on('end', () => {
        if (!data.includes('#EXTM3U')) {
          return res.status(502).send('Invalid M3U8');
        }
        
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        const rewritten = data.split('\n').map(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed === '') return line;
          
          const fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
          const b64 = Buffer.from(fullUrl).toString('base64');
          return `${PUBLIC_URL}/proxy/${b64}`;
        }).join('\n');
        
        res.send(rewritten);
      });
    } else {
      proxyRes.pipe(res);
    }
  });
  
  proxyReq.on('error', error => {
    console.error(`❌ Proxy error: ${error.message}`);
    if (!res.headersSent) res.status(502).json({ error: error.message });
  });
  
  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Timeout' });
  });
  
  proxyReq.end();
}

function setupProxy(app) {
  app.get('/stream/:streamId/:feedId', async (req, res) => {
    try {
      const { streamId, feedId } = req.params;
      
      const streamData = streamMapping.get(streamId);
      if (!streamData) {
        console.log(`❌ Stream not found: ${streamId}`);
        return res.status(404).send('Stream not found');
      }
      
      const feedIndex = parseInt(feedId.replace(/\D/g, '')) - 1;
      if (feedIndex < 0 || feedIndex >= streamData.m3u8Urls.length) {
        return res.status(404).send('Feed not found');
      }
      
      const targetUrl = streamData.m3u8Urls[feedIndex];
      console.log(`📺 Stream ${streamId} feed ${feedIndex + 1}: ${targetUrl.substring(0, 60)}...`);
      
      return proxyM3u8(targetUrl, res);
      
    } catch (error) {
      console.error(`❌ Stream error: ${error.message}`);
      if (!res.headersSent) res.status(500).send('Stream error');
    }
  });
  
  app.get('/proxy/:b64url', async (req, res) => {
    try {
      const targetUrl = Buffer.from(req.params.b64url, 'base64').toString('utf8');
      console.log(`📡 Proxy: ${targetUrl.substring(0, 70)}...`);
      return proxyM3u8(targetUrl, res);
    } catch (error) {
      console.error(`❌ Proxy error: ${error.message}`);
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });
}

// ============================================================================
// STREMIO ADDON
// ============================================================================

const manifest = {
  id: 'community.ppvto.livesports.render',
  version: '1.0.0',
  name: 'PPV.to Live Sports',
  description: 'Live sports streams from PPV.to',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [{
    type: 'tv',
    id: 'ppvto_live',
    name: 'Live Now'
  }],
  idPrefixes: ['ppvto_']
};

const app = express();
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

setupProxy(app);

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/tv/:id.json', (req, res) => {
  if (req.params.id !== 'ppvto_live') return res.json({ metas: [] });
  
  const metas = cachedStreams.map(s => ({
    id: s.id,
    type: 'tv',
    name: s.title,
    poster: 'https://via.placeholder.com/300x450/FF0000/FFFFFF?text=LIVE',
    description: s.channel ? `${s.channel}\n\n🔴 LIVE NOW` : '🔴 LIVE NOW',
    genres: ['Sports', 'Live']
  }));
  
  res.json({ metas });
});

app.get('/meta/tv/:id.json', (req, res) => {
  const stream = cachedStreams.find(s => s.id === req.params.id);
  if (!stream) return res.json({ meta: null });
  
  res.json({
    meta: {
      id: stream.id,
      type: 'tv',
      name: stream.title,
      poster: 'https://via.placeholder.com/300x450/FF0000/FFFFFF?text=LIVE',
      description: stream.channel ? `${stream.channel}\n\n🔴 LIVE NOW` : '🔴 LIVE NOW',
      genres: ['Sports', 'Live']
    }
  });
});

app.get('/stream/tv/:id.json', (req, res) => {
  const stream = cachedStreams.find(s => s.id === req.params.id);
  if (!stream) return res.json({ streams: [] });
  
  const streams = stream.streamUrls.map((url, idx) => ({
    url: url,
    title: `${stream.title} - Feed ${idx + 1}`,
    behaviorHints: { notWebReady: false }
  }));
  
  res.json({ streams });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    publicUrl: PUBLIC_URL,
    cachedStreams: cachedStreams.length,
    lastScrape: lastScrapeTime,
    isScraping: isScraping
  });
});

app.get('/debug/scrape', (req, res) => {
  if (isScraping) return res.json({ success: false, message: 'Already scraping' });
  res.json({ success: true, message: 'Scraping started - check logs' });
  runScraper();
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>PPV.to Stremio Addon</title>
      <style>
        body { font-family: Arial; max-width: 900px; margin: 50px auto; padding: 20px; background: #1a1a1a; color: #fff; }
        .status { padding: 20px; background: #2a2a2a; border-radius: 8px; margin-bottom: 20px; }
        .success { color: #4CAF50; }
      </style>
    </head>
    <body>
      <h1>🎬 PPV.to Stremio Addon</h1>
      <div class="status">
        <h2>Status: <span class="success">✅ Online</span></h2>
        <p>Public URL: <strong>${PUBLIC_URL}</strong></p>
        <p>Cached Streams: <strong>${cachedStreams.length}</strong></p>
        <p>Last Scrape: <strong>${lastScrapeTime || 'Starting...'}</strong></p>
      </div>
      <div class="status">
        <h2>📦 Install</h2>
        <p><a href="stremio://${PUBLIC_URL}/manifest.json" style="color: #4CAF50">Install Addon</a></p>
        <p>Or: <code>${PUBLIC_URL}/manifest.json</code></p>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server: ${PUBLIC_URL}`);
  console.log(`⚡ Scrape interval: ${SCRAPE_INTERVAL / 1000}s\n`);
  startScheduler();
});