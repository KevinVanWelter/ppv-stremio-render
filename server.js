// IMPROVED SCRAPER - Process each event
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
          waitUntil: 'networkidle0', // Wait for network to be idle
          timeout: 20000
        }).catch(e => {
          console.log(`    ⚠️  Navigation timeout`);
        });
        
        // Critical: Wait longer for streams to load
        console.log(`    ⏳ Waiting for streams to load...`);
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // Check what we got
        if (eventM3u8Urls.length > 0) {
          console.log(`    ✅ Found m3u8, waiting for variants...`);
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
                  // Try to play the video
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
          
          // Final wait
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