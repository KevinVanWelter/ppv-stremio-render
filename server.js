// ============================================================================
// COMPLETE SCRAPER FUNCTION - Replace entire scrapePPVLiveStreams function
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
        '--disable-software-rasterizer'
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
        
        // Navigate and wait for network to settle
        await page.goto(event.href, {
          waitUntil: 'networkidle0',
          timeout: 20000
        }).catch(e => {
          console.log(`    ⚠️  Navigation timeout: ${e.message}`);
        });
        
        // CRITICAL: Wait longer for streams to load
        console.log(`    ⏳ Waiting 5s for streams to load...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check what we got
        if (eventM3u8Urls.length > 0) {
          console.log(`    ✅ Found ${eventM3u8Urls.length} m3u8(s), waiting for variants...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          // Try interacting with video players in iframes
          console.log(`    🎬 Trying video interaction...`);
          const frames = page.frames();
          
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
                console.log(`    📺 Found video in frame ${frameIndex}, waiting...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                if (eventM3u8Urls.length > 0) {
                  console.log(`    ✅ m3u8 loaded after video interaction`);
                  break;
                }
              }
            } catch (e) {}
          }
          
          // Final wait if still nothing
          if (eventM3u8Urls.length === 0) {
            console.log(`    ⏳ Final wait...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        
        // Clean up listeners
        page.off('request', requestHandler);
        page.off('response', responseHandler);
        
        // Process results
        if (eventM3u8Urls.length > 0) {
          const uniqueUrls = [...new Set(eventM3u8Urls)];
          console.log(`    ✅ Found ${uniqueUrls.length} unique m3u8 URL(s)`);
          
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
          
          console.log(`    ✅ Saved ${urlsToUse.length} stream(s) for this event`);
        } else {
          console.log(`    ❌ No streams found for this event`);
        }
        
      } catch (error) {
        console.log(`    ❌ Error processing event: ${error.message}`);
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