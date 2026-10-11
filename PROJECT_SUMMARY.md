# Project Summary

## Overview

**tev1** is a real-time collaborative WebSocket-based office decision-making platform with a PWA frontend.

## Components

### 1. WebSocket Server (`server/`)
- **Technology**: Node.js 20+, ws library
- **Purpose**: Real-time bidirectional communication for collaborative decision-making
- **Features**:
  - Room management and user presence
  - Real-time cursor sharing
  - JWT authentication
  - Redis Pub/Sub for scaling
  - REST API for health checks and token management
  - Heartbeat monitoring with auto-reconnect

### 2. PWA Frontend (`wemarket1/`)
- **Technology**: Vanilla HTML/JS/CSS
- **Purpose**: Client application for accessing the decision desk
- **Features**:
  - Progressive Web App (installable, offline-capable)
  - Service Worker for asset caching
  - Responsive design
  - WebSocket client integration

### 3. Infrastructure
- **Containerization**: Docker (multi-stage builds)
- **Orchestration**: Kubernetes with Kustomize (base + production overlays)
- **CI/CD**: GitHub Actions for automated deployment
- **Monitoring**: Prometheus + Grafana for observability
- **TLS**: cert-manager with Let's Encrypt for automatic HTTPS
- **Ingress**: nginx-ingress controller

## Architecture

The system uses a client-server architecture with WebSocket for real-time communication. Multiple server pods can be deployed behind a load balancer, with Redis providing Pub/Sub for cross-pod messaging and session state.

## Recent Changes

Recent commits (main branch):
1. `80c1be8` - fix(k8s): clean up base manifests (remove duplicate LOG_LEVEL, trailing generators)
2. `72d2c84` - chore(wemarket1): update examples and vercel config; add .gitignore

## Deployment

- **Production**: Automated via GitHub Actions on push to `main` branch
- **Kubernetes**: Deployed using Kustomize overlays in `server/k8s/overlays/production/`
- **Frontend**: Configured for Vercel deployment

## Documentation

- [README.md](README.md) - Main project overview
- [DEPLOYMENT.md](DEPLOYMENT.md) - Detailed Kubernetes deployment guide
- [server/README.md](server/README.md) - Server API and protocol documentation
- [server/k8s/README.md](server/k8s/README.md) - Kubernetes manifests documentation (if present)
- [wemarket1/README.md](wemarket1/README.md) - PWA frontend documentation
