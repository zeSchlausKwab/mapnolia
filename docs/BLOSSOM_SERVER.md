# Blossom Server Configuration

## Overview

The Earthly project now includes a dedicated Blossom server (BUD-01 compliant) that serves map chunk files from the `map-chunks/` directory.

## Production Setup

### DNS Configuration

Add an A record for the Blossom subdomain:

```
Type: A Record
Host: blossom
Value: 159.198.47.154 (your VPS IP)
TTL: Automatic
```

Full domain: `blossom.earthly.city`

### Services Running on VPS

After deployment, the following PM2 services run:

1. **earthly-web** (Port 3000)
   - Main web application
   - Domain: `earthly.city`

2. **earthly-contextvm** (Port varies)
   - ContextVM server

3. **earthly-blossom** (Port 3001) ⭐ NEW
   - Blossom server for map chunks
   - Domain: `blossom.earthly.city`

### Caddy Configuration

The Caddyfile now includes:

```caddy
# Blossom server for map chunks
blossom.earthly.city {
    reverse_proxy 127.0.0.1:3001
    encode gzip
    
    log {
        output file /var/log/caddy/blossom-access.log
        format json
    }
}
```

Caddy automatically provisions SSL certificates for `blossom.earthly.city`.

## Blossom Server Features

### Endpoints

- `GET /<sha256>` - Retrieve blob by hash
- `GET /<sha256>.pmtiles` - Retrieve with extension
- `HEAD /<sha256>` - Check if blob exists
- `OPTIONS /<sha256>` - CORS preflight

### Supported File Types

- `.pmtiles` - Map tile archives (primary)
- `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` - Images and documents
- `.json` - JSON data
- No extension - Generic files

### CORS Support

Full CORS support with the following headers:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Authorization, *`
- `Access-Control-Allow-Methods: GET, HEAD, PUT, DELETE`

### Range Requests

The server fully supports HTTP Range requests for efficient streaming of large PMTiles files.

## Directory Structure

```
/var/www/earthly/
├── map-chunks/              # Blossom-served files
│   ├── <sha256>.pmtiles    # Chunked map tiles
│   └── announcement.json   # Chunk manifest
├── src/
│   ├── index.ts            # Main web server
│   └── blossom.ts          # Blossom server
└── logs/
    ├── web-*.log
    ├── contextvm-*.log
    └── blossom-*.log       # Blossom server logs
```

## Deployment

The Blossom server is automatically deployed and started:

```bash
./scripts/deploy.sh
```

This will:
1. Deploy the updated code
2. Create the `map-chunks/` directory if missing
3. Start the Blossom server on port 3001
4. Update Caddy configuration

## Using the Blossom Server

### Access a Chunk

Once chunks are generated, access them via:

```
https://blossom.earthly.city/<sha256>.pmtiles
```

For example:
```
https://blossom.earthly.city/a1b2c3d4e5f6789...sha256hash....pmtiles
```

### Server Info

Check server status:
```
https://blossom.earthly.city/
```

Returns:
```json
{
  "name": "earthly-blossom",
  "version": "1.0.0",
  "description": "Blossom server for Earthly map-chunks PMTiles",
  "environment": "production",
  "mapChunksDir": "/var/www/earthly/map-chunks"
}
```

## Monitoring

### Check Status

```bash
ssh deploy@server1
pm2 status
pm2 logs earthly-blossom
```

### View Logs

```bash
# Real-time logs
pm2 logs earthly-blossom -f

# Log files
tail -f /var/www/earthly/logs/blossom-out.log
tail -f /var/www/earthly/logs/blossom-error.log

# Caddy logs
sudo tail -f /var/log/caddy/blossom-access.log
```

### Restart Blossom Server

```bash
ssh deploy@server1
pm2 restart earthly-blossom
```

## Development

### Run Locally

```bash
bun run blossom
# or
bun --hot src/blossom.ts
```

Server runs on `http://localhost:3001`

### Environment Variables

- `BLOSSOM_PORT` - Port number (default: 3001)
- `NODE_ENV` - Set to `production` for production mode

## Integration with Frontend

Update your frontend configuration to use the Blossom server:

```typescript
const BLOSSOM_SERVER = 'https://blossom.earthly.city'

// Access a chunk
const chunkUrl = `${BLOSSOM_SERVER}/${sha256}.pmtiles`
```

The chunking process automatically generates `map-chunks/announcement.json` with all available chunks, which can be served to the frontend to discover available tiles.

## Troubleshooting

### Server Not Starting

Check logs:
```bash
pm2 logs earthly-blossom --err
```

Verify port is available:
```bash
sudo netstat -tlnp | grep 3001
```

### Files Not Found

Verify map-chunks directory:
```bash
ls -lh /var/www/earthly/map-chunks/
```

Check permissions:
```bash
ls -la /var/www/earthly/ | grep map-chunks
```

### SSL Certificate Issues

Caddy should auto-provision certificates. Check Caddy logs:
```bash
sudo journalctl -u caddy -f
```

Manually reload Caddy:
```bash
sudo systemctl reload caddy
```

## Next Steps

1. ✅ Deploy the updated configuration
2. ⏳ Add DNS A record for `blossom.earthly.city`
3. ⏳ Run the chunking process (see `docs/VPS_CHUNKING.md`)
4. ⏳ Update frontend to use Blossom server URLs
5. ⏳ Test chunk downloads from the frontend

## Performance Notes

- Blossom server is lightweight (~50-100MB RAM)
- Supports concurrent downloads
- Gzip compression via Caddy
- Range requests enable efficient streaming
- No authentication required for read-only access

## Security

- Read-only in production (GET/HEAD only)
- CORS enabled for cross-origin access
- SSL/TLS via Caddy
- No write operations exposed
- Files are content-addressed (SHA-256)
