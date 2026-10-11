# WeMarket1 - PWA Frontend

PWA (Progressive Web App) frontend for the Pixel Office Decision Desk project.

## Features

- Progressive Web App support (offline capability)
- Service Worker for caching
- App manifest for installability
- Responsive design
- Real-time WebSocket client

## Development

### Local Development

Serve the static files using any HTTP server:

```bash
# Using Python
python3 -m http.server 3000

# Using Node.js http-server
npx http-server -p 3000

# Using Vite (if configured)
npm run dev
```

### Deployment

The app is configured for deployment on Vercel. See `vercel.json` for configuration.

```bash
vercel --prod
```

## Files

- `index.html` - Main application entry point
- `manifest.json` - PWA manifest
- `sw.js` - Service Worker for offline caching
- `offline.html` - Offline fallback page
- `vercel.json` - Vercel deployment configuration
- Icons: `badge-72.png`, `icon-192.png`, `icon-512.png`

## PWA Features

- Installable on mobile and desktop devices
- Works offline (cached assets)
- App-like experience with standalone display mode
