const puppeteer = require('puppeteer');

// ============================================================================
// TEST SCRAPER - Run locally to test before deploying
// ============================================================================

async function scrapePPVLiveStreams() {
  let browser;
  
  try {
    console.log('🚀 Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new', // Set to false to see what's happening!
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-webrtc',
        '--mute-audio'
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
    
    // TEST JUST THE FIRST EVENT
    console.log('🧪 Testing first event only (for speed)...\n');
    const results = [];
    
    // Just test first event
    const event = liveEvents.events[0];
    console.log(`\n▶️  Testing: ${event.title}`);
    
    const eventM3u8Urls = [];
    
    // Set up listeners
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
      
      await page.goto(event.href, {
        waitUntil: 'domcontentloaded',
        timeout: 25000
      }).catch(e => {
        console.log(`    ⚠️  Navigation timeout (continuing): ${e.message}`);
      });
      
      console.log(`    ⏳ Waiting for streams...`);
      let waited = 0;
      const maxInitialWait = 8000;
      const checkInterval = 500;
      
      while (eventM3u8Urls.length === 0 && waited < maxInitialWait) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        waited += checkInterval;
        if (waited % 2000 === 0) {
          console.log(`       ... ${waited / 1000}s elapsed, ${eventM3u8Urls.length} m3u8s found`);
        }
      }
      
      if (eventM3u8Urls.length > 0) {
        console.log(`    ✅ Found m3u8 after ${waited}ms, waiting for variants...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log(`    🎬 No m3u8 after ${waited}ms, trying video interaction...`);
        const frames = page.frames();
        console.log(`       Found ${frames.length} frames`);
        
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
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
              console.log(`    📺 Video found in frame ${frameIndex}, waiting for m3u8...`);
              
              let videoWaited = 0;
              const maxVideoWait = 5000;
              
              while (eventM3u8Urls.length === 0 && videoWaited < maxVideoWait) {
                await new Promise(resolve => setTimeout(resolve, 500));
                videoWaited += 500;
                if (videoWaited % 1000 === 0) {
                  console.log(`       ... ${videoWaited / 1000}s after video click, ${eventM3u8Urls.length} m3u8s found`);
                }
              }
              
              if (eventM3u8Urls.length > 0) {
                console.log(`    ✅ m3u8 loaded after ${videoWaited}ms of video interaction`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                break;
              } else {
                console.log(`    ⚠️  No m3u8 after ${videoWaited}ms in frame ${frameIndex}`);
              }
            } else {
              console.log(`    ℹ️  No video element in frame ${frameIndex}`);
            }
          } catch (e) {
            console.log(`    ⚠️  Error in frame ${frameIndex}: ${e.message}`);
          }
        }
      }
      
      page.off('request', requestHandler);
      page.off('response', responseHandler);
      
      if (eventM3u8Urls.length > 0) {
        console.log(`    ⏳ Final check for additional streams...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (eventM3u8Urls.length > 0) {
        const uniqueUrls = [...new Set(eventM3u8Urls)];
        console.log(`    ✅ Total found: ${uniqueUrls.length} unique m3u8 URL(s)`);
        
        uniqueUrls.forEach((url, idx) => {
          console.log(`       ${idx + 1}. ${url}`);
        });
        
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
        
        console.log(`    ✅ SUCCESS! Saved ${urlsToUse.length} stream(s)`);
      } else {
        console.log(`    ❌ FAILED: No streams found`);
      }
      
    } catch (error) {
      console.log(`    ❌ Error: ${error.message}`);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('📊 TEST RESULTS');
    console.log('='.repeat(80));
    console.log(`Events tested: 1`);
    console.log(`Streams found: ${results.length}`);
    if (results.length > 0) {
      console.log(`\nStream details:`);
      results.forEach(r => {
        console.log(`  ${r.title}: ${r.m3u8Urls.length} m3u8(s)`);
      });
    }
    console.log('='.repeat(80) + '\n');
    
    console.log('⏸️  Browser staying open for inspection. Press Ctrl+C to close.');
    // Don't close browser so you can inspect
    // await browser.close();
    
    return results;
    
  } catch (error) {
    console.error('❌ Test error:', error);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return [];
  }
}

// Run the test
console.log('\n🧪 PPV.to Scraper Test\n');
scrapePPVLiveStreams().then(results => {
  if (results.length > 0) {
    console.log('✅ Test passed! Scraper is working.');
  } else {
    console.log('❌ Test failed! No streams detected.');
  }
}).catch(error => {
  console.error('❌ Test crashed:', error);
  process.exit(1);
});