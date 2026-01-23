const express = require('express');
const puppeteer = require('puppeteer');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 10000;
const SCRAPE_INTERVAL = 90 * 1000; // 90 seconds

// Render URL detection - Render doesn't set RENDER_EXTERNAL_URL automatically
// You need to manually set it in Render dashboard or use the service name
function getPublicUrl() {
  // Check if manually set
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  
  // Check if RENDER environment (Render sets RENDER=true)
  if (process.env.RENDER === 'true') {
    // Construct from service name if available
    // Format: https://{service-name}.onrender.com
    const serviceName = process.env.RENDER_SERVICE_NAME || 'ppv-stremio-addon';
    return `https://${serviceName}.onrender.com`;
  }
  
  // Local fallback
  return `http://localhost:${PORT}`;
}

const PUBLIC_URL = getPublicUrl();

console.log('🔍 Environment variables:');
console.log(`   RENDER: ${process.env.RENDER}`);
console.log(`   RENDER_EXTERNAL_URL: ${process.env.RENDER_EXTERNAL_URL || 'not set'}`);
console.log(`   RENDER_SERVICE_NAME: ${process.env.RENDER_SERVICE_NAME || 'not set'}`);
console.log(`   PORT: ${PORT}`);
console.log(`🔗 PUBLIC_URL set to: ${PUBLIC_URL}`);

// ============================================================================
// STATE
// ============================================================================

let cachedStreams = [];
let lastScrapeTime = null;
let isScraping = false;

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
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-webrtc', // Disable WebRTC to reduce UDP port noise
        '--disable-webgl',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--disable-default-apps'
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
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
      window.open = function() { return null; };
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    });
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br'
    });
    
    console.log('🏠 Navigating to ppv.to...');
    
    try {
      await page.goto('https://ppv.to/', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
    } catch (e) {
      console.log('⚠️  Page load timeout, continuing...');
    }
    
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
        
        if (!liveNowElement && lowerText === 'live now' && 
            (el.tagName.match(/H[1-6]/) || el.innerHTML.includes('🔴') || text.includes('🔴'))) {
          liveNowElement = el;
          break;
        }
      }
      
      if (!liveNowElement) {
        return { events, error: 'Could not find Live now heading' };
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
        
        if (seenHrefs.has(href)) {
          continue;
        }
        
        const card = link.closest('[class*="card"], [class*="item"], div');
        if (!card) {
          continue;
        }
        
        const titleEl = card.querySelector('h5, h4, h3, [class*="title"]');
        let title = '';
        
        if (titleEl) {
          const allH5s = card.querySelectorAll('h5');
          title = allH5s.length > 0 ? allH5s[0].textContent.trim() : titleEl.textContent.trim();
        } else {
          title = card.textContent.trim().split('\n')[0].trim();
        }
        
        title = title.replace(/\s+/g, ' ').trim();
        
        if (seenTitles.has(title)) {
          continue;
        }
        
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
      console.log(`❌ Error: ${liveEvents.error}`);
      await browser.close();
      return [];
    }
    
    console.log(`📊 Found ${liveEvents.events.length} live events\n`);
    
    if (liveEvents.events.length === 0) {
      await browser.close();
      return [];
    }
    
    // PROCESS EACH EVENT
    const results = [];
    
    for (let i = 0; i < liveEvents.events.length; i++) {
      const event = liveEvents.events[i];
      console.log(`\n▶️  Processing event ${i + 1}/${liveEvents.events.length}: ${event.title}`);
      
      const eventM3u8Urls = [];
      
      // Set up listeners BEFORE navigation
      const requestHandler = request => {
        const url = request.url();
        if (url.includes('.m3u8')) {
          console.log(`    📡 Found m3u8 in request: ${url.substring(0, 80)}...`);
          eventM3u8Urls.push(url);
        }
      };
      
      const responseHandler = async (response) => {
        try {
          const url = response.url();
          if (url.includes('.m3u8')) {
            console.log(`    📡 Found m3u8 in response: ${url.substring(0, 80)}...`);
            eventM3u8Urls.push(url);
          }
        } catch (e) {}
      };
      
      page.on('request', requestHandler);
      page.on('response', responseHandler);
      
      try {
        console.log(`    🔗 Navigating to: ${event.href}`);
        
        // Navigate with faster wait condition
        await page.goto(event.href, {
          waitUntil: 'domcontentloaded', // Faster than networkidle0
          timeout: 15000
        }).catch(e => {
          console.log(`    ⚠️  Navigation timeout: ${e.message}`);
        });
        
        // Wait for streams to start loading - adaptive wait
        console.log(`    ⏳ Waiting for streams...`);
        let waited = 0;
        const maxInitialWait = 6000; // Max 6 seconds
        const checkInterval = 500;
        
        while (eventM3u8Urls.length === 0 && waited < maxInitialWait) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          waited += checkInterval;
        }
        
        if (eventM3u8Urls.length > 0) {
          console.log(`    ✅ Found m3u8 after ${waited}ms`);
        }
        if (eventM3u8Urls.length > 0) {
          console.log(`    ✅ Found m3u8 after ${waited}ms`);
          // Wait a bit more for variant playlists
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          // Try interacting with video players in iframes
          console.log(`    🎬 No m3u8 found, trying video interaction...`);
          const frames = page.frames();
          
          for (let frameIndex = 0; frameIndex < frames.length && eventM3u8Urls.length === 0; frameIndex++) {
            const frame = frames[frameIndex];
            try {
              const hasVideo = await frame.evaluate(() => {
                const video = document.querySelector('video');
                if (video) {
                  video.muted = true;
                  video.click();
                  const playPromise = video.play();
                  if (playPromise !== undefined) {
                    playPromise.catch(e => {});
                  }
                  return true;
                }
                return false;
              }).catch(() => false);
              
              if (hasVideo) {
                console.log(`    📺 Video found in frame ${frameIndex}`);
                // Wait for m3u8 after interaction
                let videoWaited = 0;
                const maxVideoWait = 3000;
                
                while (eventM3u8Urls.length === 0 && videoWaited < maxVideoWait) {
                  await new Promise(resolve => setTimeout(resolve, 500));
                  videoWaited += 500;
                }
                
                if (eventM3u8Urls.length > 0) {
                  console.log(`    ✅ m3u8 loaded after video interaction (${videoWaited}ms)`);
                  break;
                }
              }
            } catch (e) {
              // Frame errors are normal, continue
            }
          }
        }
        // Clean up listeners
        page.off('request', requestHandler);
        page.off('response', responseHandler);
        
        // Give a final moment for any last m3u8s to arrive
        if (eventM3u8Urls.length > 0) {
          console.log(`    ⏳ Final check for additional streams...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Process results
        if (eventM3u8Urls.length > 0) {
          const uniqueUrls = [...new Set(eventM3u8Urls)];
          console.log(`    ✅ Total found: ${uniqueUrls.length} unique m3u8 URL(s)`);
          
          // Prefer master playlists
          const masterPlaylists = uniqueUrls.filter(url => 
            url.includes('index.m3u8') || 
            url.includes('master.m3u8') || 
            url.includes('playlist.m3u8')
          );
          
          const urlsToUse = masterPlaylists.length > 0 ? masterPlaylists : uniqueUrls;
          
          results.push({
            title: event.title,
            channel: event.channel,
            href: event.href,
            m3u8Urls: urlsToUse
          });
          
          console.log(`    ✅ Saved ${urlsToUse.length} stream(s) for "${event.title}"`);
        } else {
          console.log(`    ❌ No streams found for "${event.title}"`);
        }
        
      } catch (error) {
        console.log(`    ❌ Error processing event: ${error.message}`);
        // Clean up listeners on error
        try {
          page.off('request', requestHandler);
          page.off('response', responseHandler);
        } catch (e) {}
      }
      
      // Small delay between events to avoid rate limiting
      if (i < liveEvents.events.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await browser.close();
    
    console.log(`\n✅ Scrape complete: ${results.length}/${liveEvents.events.length} streams found\n`);
    
    return results;
    
  } catch (error) {
    console.error('❌ Scraping error:', error);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return [];
  }
}

// ============================================================================
// SCRAPER SCHEDULER
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
    
    if (results.length === 0) {
      console.log('\n⚠️  No streams found in this scrape\n');
      cachedStreams = [];
      lastScrapeTime = new Date().toISOString();
      return;
    }
    
    cachedStreams = results.map((stream, index) => ({
      id: `ppvto_${index}`,
      title: stream.title,
      channel: stream.channel,
      href: stream.href,
      m3u8Urls: stream.m3u8Urls.map(url => {
        const b64 = Buffer.from(url).toString('base64');
        return `${PUBLIC_URL}/proxy/${b64}`;
      })
    }));
    
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
  runScraper(); // Run immediately
  setInterval(runScraper, SCRAPE_INTERVAL);
}

// ============================================================================
// PROXY
// ============================================================================

function setupProxy(app) {
  app.get('/proxy/:b64url', async (req, res) => {
    try {
      const targetUrl = Buffer.from(req.params.b64url, 'base64').toString('utf8');
      
      console.log(`📡 Proxy request: ${targetUrl.substring(0, 80)}...`);
      
      const urlObj = new URL(targetUrl);
      const protocol = urlObj.protocol === 'https:' ? https : http;
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://ppv.to',
          'Referer': 'https://ppv.to/',
          'Connection': 'keep-alive'
        }
      };
      
      if (req.headers.range) {
        options.headers['Range'] = req.headers.range;
      }
      
      const proxyReq = protocol.request(options, (proxyRes) => {
        // Handle redirects
        if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302 || proxyRes.statusCode === 307 || proxyRes.statusCode === 308) {
          const redirectUrl = proxyRes.headers.location;
          if (redirectUrl) {
            const newB64 = Buffer.from(redirectUrl).toString('base64');
            console.log(`↪️  Redirect to: ${redirectUrl.substring(0, 80)}...`);
            return res.redirect(`/proxy/${newB64}`);
          }
        }
        
        res.statusCode = proxyRes.statusCode;
        
        // Copy relevant headers
        if (proxyRes.headers['content-type']) {
          res.setHeader('Content-Type', proxyRes.headers['content-type']);
        }
        if (proxyRes.headers['content-length']) {
          res.setHeader('Content-Length', proxyRes.headers['content-length']);
        }
        if (proxyRes.headers['content-range']) {
          res.setHeader('Content-Range', proxyRes.headers['content-range']);
        }
        if (proxyRes.headers['accept-ranges']) {
          res.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
        }
        
        // Set cache headers for better performance
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        if (targetUrl.includes('.m3u8')) {
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          
          let data = '';
          
          proxyRes.on('data', chunk => {
            data += chunk.toString('utf8');
          });
          
          proxyRes.on('end', () => {
            const isValidM3U8 = data.includes('#EXTM3U') || data.includes('#EXT-X-');
            
            if (!isValidM3U8) {
              console.log('❌ Invalid M3U8 response');
              return res.status(502).send('Invalid M3U8 response');
            }
            
            const lines = data.split('\n');
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            
            const rewrittenLines = lines.map(line => {
              const trimmed = line.trim();
              
              if (trimmed.startsWith('#') || trimmed === '') {
                return line;
              }
              
              let fullUrl;
              if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                fullUrl = trimmed;
              } else {
                fullUrl = baseUrl + trimmed;
              }
              
              const b64 = Buffer.from(fullUrl).toString('base64');
              return `${PUBLIC_URL}/proxy/${b64}`;
            });
            
            const rewritten = rewrittenLines.join('\n');
            console.log(`✅ Rewrote M3U8 (${lines.length} lines)`);
            res.send(rewritten);
          });
        } else {
          // For video segments, just pipe through
          proxyRes.pipe(res);
        }
      });
      
      proxyReq.on('error', error => {
        console.error(`❌ Proxy error: ${error.message}`);
        if (!res.headersSent) {
          res.status(502).json({ error: error.message });
        }
      });
      
      proxyReq.setTimeout(30000, () => {
        console.error('❌ Proxy timeout');
        proxyReq.destroy();
        if (!res.headersSent) {
          res.status(504).json({ error: 'Gateway timeout' });
        }
      });
      
      proxyReq.end();
      
    } catch (error) {
      console.error(`❌ Proxy setup error: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
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
  description: 'Live sports streams from PPV.to (Render)',
  logo: 'https://via.placeholder.com/256x256/FF0000/FFFFFF?text=PPV',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'ppvto_live',
      name: 'Live Now',
      extra: [{ name: 'skip', isRequired: false }]
    }
  ],
  idPrefixes: ['ppvto_']
};

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();

// Trust proxy (important for Render)
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.header('Access-Control-Expose-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

setupProxy(app);

app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

app.get('/catalog/tv/:id.json', async (req, res) => {
  try {
    if (req.params.id !== 'ppvto_live') {
      return res.json({ metas: [] });
    }

    const metas = cachedStreams.map((stream) => ({
      id: stream.id,
      type: 'tv',
      name: stream.title,
      poster: 'https://via.placeholder.com/300x450/FF0000/FFFFFF?text=LIVE',
      description: stream.channel ? `${stream.channel}\n\n🔴 LIVE NOW` : '🔴 LIVE NOW',
      genres: ['Sports', 'Live'],
      releaseInfo: '🔴 LIVE'
    }));

    res.json({ metas });
  } catch (error) {
    console.error('Catalog error:', error);
    res.json({ metas: [] });
  }
});

app.get('/meta/tv/:id.json', async (req, res) => {
  try {
    const stream = cachedStreams.find(s => s.id === req.params.id);
    
    if (!stream) {
      return res.json({ meta: null });
    }

    res.json({
      meta: {
        id: stream.id,
        type: 'tv',
        name: stream.title,
        poster: 'https://via.placeholder.com/300x450/FF0000/FFFFFF?text=LIVE',
        description: stream.channel ? `Channel: ${stream.channel}\n\n🔴 LIVE NOW` : '🔴 LIVE NOW',
        genres: ['Sports', 'Live'],
        releaseInfo: '🔴 LIVE'
      }
    });
  } catch (error) {
    console.error('Meta error:', error);
    res.json({ meta: null });
  }
});

app.get('/stream/tv/:id.json', async (req, res) => {
  try {
    const stream = cachedStreams.find(s => s.id === req.params.id);
    
    if (!stream) {
      return res.json({ streams: [] });
    }

    const streams = stream.m3u8Urls.map((url, idx) => ({
      url: url,
      title: `${stream.title} - Feed ${idx + 1}`,
      behaviorHints: {
        notWebReady: false
      }
    }));

    res.json({ streams });
  } catch (error) {
    console.error('Stream error:', error);
    res.json({ streams: [] });
  }
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>PPV.to Stremio Addon (Render)</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          max-width: 900px;
          margin: 50px auto;
          padding: 20px;
          background: #1a1a1a;
          color: #fff;
        }
        .status {
          padding: 20px;
          background: #2a2a2a;
          border-radius: 8px;
          margin-bottom: 20px;
        }
        .success { color: #4CAF50; }
        .warning { color: #FFC107; }
        .error { color: #f44336; }
        .install-link {
          background: #4CAF50;
          color: white;
          padding: 15px 30px;
          text-decoration: none;
          border-radius: 5px;
          display: inline-block;
          margin: 20px 0;
          font-weight: bold;
        }
        .code {
          background: #000;
          padding: 15px;
          border-radius: 5px;
          overflow-x: auto;
          font-family: monospace;
          font-size: 14px;
        }
        .stream-list {
          max-height: 400px;
          overflow-y: auto;
          background: #000;
          padding: 10px;
          border-radius: 5px;
        }
        .stream-item {
          padding: 10px;
          margin: 5px 0;
          background: #1a1a1a;
          border-left: 3px solid #4CAF50;
        }
      </style>
    </head>
    <body>
      <h1>🎬 PPV.to Stremio Addon</h1>
      
      <div class="status">
        <h2>Status: <span class="success">✅ Online</span></h2>
        <p>Public URL: <strong>${PUBLIC_URL}</strong></p>
        <p>Cached Streams: <strong>${cachedStreams.length}</strong></p>
        <p>Last Scrape: <strong>${lastScrapeTime || 'Starting...'}</strong></p>
        <p>Scrape Interval: <strong>90 seconds</strong></p>
        <p>Currently Scraping: <strong>${isScraping ? 'Yes' : 'No'}</strong></p>
      </div>

      <div class="status">
        <h2>📦 Install in Stremio</h2>
        <a href="stremio://${PUBLIC_URL}/manifest.json" class="install-link">
          📦 Install Addon
        </a>
        <p>Or manually add:</p>
        <div class="code">${PUBLIC_URL}/manifest.json</div>
      </div>

      <div class="status">
        <h2>🔴 Current Live Streams</h2>
        ${cachedStreams.length > 0 ? `
          <div class="stream-list">
            ${cachedStreams.map(s => `
              <div class="stream-item">
                <strong>${s.title}</strong>
                ${s.channel ? `<br><small>${s.channel}</small>` : ''}
                <br><small>${s.m3u8Urls.length} feed(s) available</small>
              </div>
            `).join('')}
          </div>
        ` : '<p class="warning">No streams currently available</p>'}
      </div>

      <div class="status">
        <h2>⚡ Why Render?</h2>
        <p>✅ Scrapes every 90 seconds (vs 5 minutes)</p>
        <p>✅ Always fresh stream URLs</p>
        <p>✅ Real HTTPS (no certificates needed)</p>
        <p>✅ Works from anywhere</p>
      </div>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    publicUrl: PUBLIC_URL,
    cachedStreams: cachedStreams.length,
    lastScrape: lastScrapeTime,
    isScraping: isScraping,
    scrapeInterval: SCRAPE_INTERVAL,
    streamDetails: cachedStreams.map(s => ({
      id: s.id,
      title: s.title,
      feedCount: s.m3u8Urls.length
    }))
  });
});

// Diagnostic endpoint to check environment
app.get('/debug/env', (req, res) => {
  res.json({
    PUBLIC_URL: PUBLIC_URL,
    PORT: PORT,
    environment: {
      RENDER: process.env.RENDER,
      RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || 'NOT SET',
      RENDER_SERVICE_NAME: process.env.RENDER_SERVICE_NAME || 'NOT SET',
      NODE_ENV: process.env.NODE_ENV
    },
    requestInfo: {
      host: req.get('host'),
      protocol: req.protocol,
      constructedUrl: `${req.protocol}://${req.get('host')}`
    },
    sampleProxyUrl: cachedStreams.length > 0 ? cachedStreams[0].m3u8Urls[0] : 'No streams cached yet'
  });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(80));
  console.log('🚀 PPV.to Stremio Addon (Render.com)');
  console.log('='.repeat(80));
  console.log(`\n📡 Server: ${PUBLIC_URL}`);
  console.log(`⚡ Scrape interval: ${SCRAPE_INTERVAL / 1000} seconds`);
  console.log(`📦 Install: ${PUBLIC_URL}/manifest.json`);
  console.log('\n' + '='.repeat(80) + '\n');
  
  startScheduler();
});