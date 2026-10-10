# tev1 - Pixel Office Decision Desk

Real-time collaborative WebSocket server for pixel-based office decision making.

## Project Structure

```
tev1/
├── server/                    # WebSocket Server (Node.js)
│   ├── src/                   # Source code
│   ├── k8s/                   # Kubernetes manifests (Kustomize)
│   │   ├── base/              # Base configuration
│   │   └── overlays/
│   │       └── production/    # Production overlay
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── package.json
│   └── README.md              # Server documentation
├── .github/
│   └── workflows/
│       └── deploy-production.yml  # CI/CD pipeline
├── DEPLOYMENT.md              # Kubernetes deployment guide
└── README.md                  # This file
```

## Quick Links

- **Server Documentation**: [server/README.md](server/README.md) - WebSocket protocol, REST API, local development
- **Kubernetes Deployment**: [DEPLOYMENT.md](DEPLOYMENT.md) - Production deployment with Kustomize
- **CI/CD Pipeline**: `.github/workflows/deploy-production.yml` - GitHub Actions workflow

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20+ |
| WebSocket | ws library |
| Auth | JWT (jsonwebtoken) |
| Container | Docker (multi-stage) |
| Orchestration | Kubernetes + Kustomize |
| CI/CD | GitHub Actions |
| Monitoring | Prometheus + Grafana |
| TLS | cert-manager + Let's Encrypt |
| Ingress | nginx-ingress |

## Getting Started

### Local Development

```bash
cd server
npm install
npm run dev
# Server: ws://localhost:8081
```

### Docker Development

```bash
cd server
docker-compose up -d
```

### Production Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for full Kubernetes deployment guide.

**Quick deploy** (after configuring secrets):
```bash
# Validate
kubectl kustomize server/k8s/overlays/production

# Deploy
kubectl apply -k server/k8s/overlays/production
```

## CI/CD Setup

1. Add `KUBECONFIG_PROD` secret to GitHub repository (Settings → Secrets → Actions)
2. Push to `main` branch triggers production deployment
3. Workflow validates kustomize rendering before applying

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────▶│  Ingress    │────▶│  Service    │
│  (Browser)  │     │  (nginx)    │     │ (LoadBal)   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    ▼                          ▼                          ▼
             ┌─────────────┐            ┌─────────────┐            ┌─────────────┐
             │  Pod 1      │            │  Pod 2      │            │  Pod N      │
             │  tev1-ws    │◀──────────▶│  tev1-ws    │◀──────────▶│  tev1-ws    │
             │  :8081      │  WebSocket │  :8081      │  WebSocket │  :8081      │
             └─────────────┘            └─────────────┘            └─────────────┘
                    │                          │                          │
                    └──────────────────────────┼──────────────────────────┘
                                               ▼
                                      ┌─────────────────┐
                                      │     Redis       │
                                      │  (Pub/Sub,      │
                                      │   Sessions)     │
                                      └─────────────────┘
```

## Features

- 🔌 **Real-time WebSocket** - Bidirectional communication
- 🔐 **JWT Authentication** - Secure token-based auth
- 🏠 **Room Management** - Create/join collaborative rooms
- 🖱️ **Cursor Sharing** - Real-time cursor position sync
- 👥 **User Presence** - Join/leave notifications
- 💓 **Heartbeat** - Auto-reconnect with exponential backoff
- 📡 **REST API** - Health checks, token generation, room management
- 🐳 **Docker Ready** - Multi-stage build, docker-compose
- ☸️ **Kubernetes Native** - Kustomize base/overlay, HPA, monitoring
- 🔄 **CI/CD** - GitHub Actions with validation
- 📊 **Observability** - Prometheus metrics, health probes

## License

MIT