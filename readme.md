# PPV.to Stremio Addon (Render.com)

Complete Stremio addon for PPV.to live sports, optimized for Render.com deployment.

## Features

- ✅ **90-second scraping** - Always fresh stream URLs
- ✅ **Self-contained** - Scraper + Proxy + Addon in one service
- ✅ **Real HTTPS** - Works from anywhere
- ✅ **No local server needed** - Fully cloud-hosted
- ✅ **Free tier** - Runs on Render.com free plan

## Quick Deploy to Render.com

### Option 1: One-Click Deploy (Easiest)

1. Click this button: [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)
2. Connect your GitHub account
3. Wait for deployment (~5 minutes)
4. Get your URL: `https://ppv-stremio-addon.onrender.com`
5. Install in Stremio!

### Option 2: Manual Deploy

1. **Create Render account** at https://render.com

2. **Create new folder** and add files:
   ```
   ppv-stremio-render/
   ├── server.js
   ├── package.json
   ├── Dockerfile
   └── render.yaml
   ```

3. **Push to GitHub**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/ppv-stremio-render.git
   git push -u origin main
   ```

4. **Deploy on Render**:
   - Go to Render Dashboard
   - Click "New +" → "Web Service"
   - Connect your GitHub repo
   - Render will auto-detect `render.yaml`
   - Click "Create Web Service"
   - Wait ~5 minutes for deployment

5. **Get your URL**:
   - Render gives you: `https://ppv-stremio-addon.onrender.com`
   - Your manifest: `https://ppv-stremio-addon.onrender.com/manifest.json`

6. **Install in Stremio**:
   - Open Stremio → Settings → Addons
   - Click ➕ icon
   - Enter: `https://ppv-stremio-addon.onrender.com/manifest.json`
   - Click Install
   - Done! 🎉

## How It Works

```
RENDER.COM (Free Tier)
├── Scraper runs every 90 seconds
├── Proxies stream URLs with proper headers
├── Serves Stremio addon API
└── Public HTTPS URL
    ↓
STREMIO (any device, anywhere)
└── Plays streams with fresh URLs
```

## Why 90 Seconds?

The m3u8 stream tokens expire every ~5 minutes. By scraping every 90 seconds:
- URLs are always fresh (max 90 seconds old)
- Streams rarely die from expired tokens
- Good balance between freshness and server load

## Important Notes

### Render Free Tier Limitations:
- ⚠️ **Spins down after 15 min inactivity** - First request may be slow
- ⚠️ **750 hours/month limit** - Should be enough for personal use
- ⚠️ **Not instant** - Takes 30-60 seconds to wake up from sleep

### To Prevent Sleep:
Use a service like [UptimeRobot](https://uptimerobot.com/) (free) to ping your Render URL every 5 minutes. This keeps it awake 24/7.

## Testing Locally

```bash
npm install
npm start
```

Visit: `http://localhost:10000`

## Environment Variables

None needed! The service auto-detects its public URL from Render.

## Troubleshooting

**Service keeps sleeping?**
- Set up UptimeRobot to ping `/health` every 5 minutes

**Streams not loading?**
- Check Render logs for scraping errors
- Make sure service is awake (visit the URL)

**No live games showing?**
- Wait for first scrape to complete (~2 minutes)
- Check if games are actually live on ppv.to

## Comparison: Render vs Local Setup

| Feature | Local Setup | Render Setup |
|---------|------------|--------------|
| Setup Complexity | High | Low |
| Requires Local Server | Yes | No |
| Works Outside Home | No | Yes |
| HTTPS | Needs certificates | Automatic |
| Scrape Frequency | 5 minutes | 90 seconds |
| Always Running | If computer on | Yes (with ping) |
| Cost | Free | Free |

## License

MIT