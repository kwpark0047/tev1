# tev1 WebSocket Server

Real-time WebSocket server for tev1 pixel office decision desk.

## Features

- 🔌 **WebSocket Server** - Real-time bidirectional communication
- 🔐 **JWT Authentication** - Secure token-based authentication
- 🏠 **Room Management** - Create/join rooms for collaboration
- 🖱️ **Cursor Sharing** - Real-time cursor position sync
- 👥 **User Presence** - User join/leave notifications
- 💓 **Heartbeat** - Auto-reconnect with exponential backoff
- 📡 **REST API** - Room management, health checks, token generation
- 🐳 **Docker Ready** - Multi-stage Dockerfile, docker-compose with Redis

## Quick Start

### Development

```bash
cd server
npm install
npm run dev
```

Server runs on `ws://localhost:8081`

### Production with Docker

```bash
cd server
docker-compose up -d
```

## WebSocket Protocol

### Connection
```javascript
const ws = new WebSocket('ws://localhost:8081');
```

### Message Types

#### Client → Server

```javascript
// Authentication
{ "type": "auth", "token": "jwt-token" }

// Join room
{ "type": "join", "roomId": "room-123", "name": "User Name" }

// Cursor position
{ "type": "cursor", "x": 100, "y": 200 }

// Leave room
{ "type": "leave" }

// Ping (heartbeat)
{ "type": "ping" }
```

#### Server → Client

```javascript
// Auth result
{ "type": "auth_result", "success": true, "userId": "uuid", "name": "User" }

// Joined room
{ "type": "joined", "id": "uuid", "name": "User", "color": "#FF6B6B", "users": [...] }

// User joined/left
{ "type": "user_joined", "userId": "...", "name": "User", "color": "#FF6B6B", "users": [...] }
{ "type": "user_left", "userId": "...", "name": "User", "users": [...] }

// Cursor update
{ "type": "cursor", "userId": "...", "x": 100, "y": 200, "name": "User", "color": "#FF6B6B" }

// Error
{ "type": "error", "message": "Invalid message format" }

// Pong
{ "type": "pong", "timestamp": 1234567890 }
```

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| POST | `/api/auth/token` | Generate JWT token |
| GET | `/api/rooms` | List all rooms |
| GET | `/api/rooms/:roomId` | Get room details |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 8081 | Server port |
| JWT_SECRET | tev1-secret | JWT signing secret |
| NODE_ENV | development | Environment |
| LOG_LEVEL | debug | Log level |

## Docker

```bash
# Build
docker build -t tev1-ws .

# Run
docker run -p 8081:8081 -e JWT_SECRET=your-secret tev1-ws

# With docker-compose
docker-compose up -d
```

## Testing

```bash
npm test
```

## Production Checklist

- [ ] Change `JWT_SECRET` in `.env`
- [ ] Configure CORS origins in `server.js`
- [ ] Set up Redis for horizontal scaling
- [ ] Enable TLS/WSS in production
- [ ] Set up monitoring (Prometheus/Grafana)
- [ ] Configure log aggregation

## License

MIT