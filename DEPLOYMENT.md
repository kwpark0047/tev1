# Kubernetes Deployment Guide

## Overview

This document describes the Kubernetes deployment setup for tev1 WebSocket server using Kustomize with base/overlay pattern.

## Directory Structure

```
server/k8s/
├── base/                          # Base configuration (common to all environments)
│   ├── configmap.yaml             # Application configuration
│   ├── deployment.yaml            # Deployment with 1 replica (dev default)
│   ├── hpa.yaml                   # HorizontalPodAutoscaler
│   ├── ingress.yaml               # Ingress with TLS
│   ├── kustomization.yaml         # Base kustomization
│   ├── namespace.yaml             # Namespace definition
│   ├── rbac.yaml                  # Role, RoleBinding, ServiceAccount
│   ├── secret.yaml                # Secrets (JWT, Redis password)
│   ├── service.yaml               # LoadBalancer + Headless services
│   ├── servicemonitor.yaml        # Prometheus ServiceMonitor
│   └── clusterissuer.yaml         # cert-manager ClusterIssuer
│
└── overlays/
    └── production/                # Production environment overlay
        └── kustomization.yaml     # Production-specific patches
```

## Base Configuration

### Resources Included

| Resource | Description |
|----------|-------------|
| Namespace | `tev1` namespace with labels |
| ServiceAccount | `tev1-ws-sa` with minimal RBAC |
| Role/RoleBinding | Pods, services, deployments access |
| ConfigMap | App config (CORS, LOG_LEVEL, WebSocket settings) |
| Secret | JWT_SECRET, REDIS_PASSWORD (placeholders) |
| Service | LoadBalancer (external) + Headless (internal) |
| Deployment | 1 replica, resources, probes, security context |
| HPA | CPU 70%, Memory 80%, WebSocket connections 500 |
| Ingress | nginx, TLS via cert-manager, WebSocket support |
| ServiceMonitor | Prometheus metrics scraping |
| ClusterIssuer | Let's Encrypt production issuer |

### Default Values (Base)

- **Replicas**: 1 (development)
- **Image**: `ghcr.io/your-org/tev1-ws:latest`
- **Resources**: 500m/256Mi requests, 1000m/512Mi limits
- **LOG_LEVEL**: info
- **Affinity**: Preferred pod anti-affinity (hostname)

## Production Overlay

### Customizations Applied

```yaml
# server/k8s/overlays/production/kustomization.yaml
namespace: tev1
resources:
  - ../../base

replicas:
  - name: tev1-ws
    count: 5                    # 5 replicas for production

images:
  - name: tev1-ws
    newTag: "v1.2.3"            # Specific version tag

patches:
  - patch: |-
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: tev1-ws
        namespace: tev1
      spec:
        template:
          spec:
            containers:
            - name: tev1-ws
              resources:
                requests:
                  cpu: "1000m"
                  memory: "512Mi"
                limits:
                  cpu: "2000m"
                  memory: "1Gi"
              env:
              - name: LOG_LEVEL
                value: "warn"
              affinity:
                podAntiAffinity:
                  requiredDuringSchedulingIgnoredDuringExecution:
                  - labelSelector:
                      matchExpressions:
                      - key: app
                        operator: In
                        values:
                        - tev1-ws
                    topologyKey: topology.kubernetes.io/zone
    target:
      kind: Deployment
      name: tev1-ws
      namespace: tev1
```

### Production vs Base Differences

| Setting | Base | Production |
|---------|------|------------|
| Replicas | 1 | 5 |
| Image Tag | latest | v1.2.3 |
| CPU Request | 500m | 1000m |
| CPU Limit | 1000m | 2000m |
| Memory Request | 256Mi | 512Mi |
| Memory Limit | 512Mi | 1Gi |
| LOG_LEVEL | info | warn |
| Affinity | Preferred (hostname) | Required (zone) |

## Deployment Commands

### Validate Configuration

```bash
# Render and validate production manifests
kubectl kustomize server/k8s/overlays/production

# Dry-run apply
kubectl apply --dry-run=client -k server/k8s/overlays/production
```

### Deploy to Production

```bash
# Apply production overlay
kubectl apply -k server/k8s/overlays/production

# Check deployment status
kubectl -n tev1 rollout status deployment/tev1-ws

# Verify pods
kubectl -n tev1 get pods -l app=tev1-ws -o wide
```

### Rollback

```bash
# Rollback to previous revision
kubectl -n tev1 rollout undo deployment/tev1-ws

# Check rollout history
kubectl -n tev1 rollout history deployment/tev1-ws
```

## CI/CD Pipeline

### GitHub Actions Workflow

Location: `.github/workflows/deploy-production.yml`

**Trigger**: Push to `main` branch with changes in `server/k8s/**`

**Steps**:
1. Checkout code
2. Set up kubectl with production kubeconfig
3. Validate kustomize rendering
4. Apply to production cluster

### Required Secrets

| Secret | Description |
|--------|-------------|
| `KUBECONFIG_PROD` | Base64-encoded kubeconfig for production cluster |

**Setup**:
```bash
# Encode kubeconfig
cat ~/.kube/config | base64 -w0

# Add as GitHub secret: KUBECONFIG_PROD
```

## Configuration Management

### Updating Image Tag

```bash
# Edit production overlay
vim server/k8s/overlays/production/kustomization.yaml

# Change newTag value
images:
  - name: tev1-ws
    newTag: "v1.2.4"   # Update version

# Commit and push triggers CI/CD
git commit -am "chore: update image to v1.2.4"
git push origin main
```

### Updating Replicas

```bash
# Edit replicas in production overlay
replicas:
  - name: tev1-ws
    count: 10   # Scale to 10 replicas
```

### Adding Environment Variables

1. Update base ConfigMap: `server/k8s/base/configmap.yaml`
2. Or add to production patch in overlay

### Managing Secrets

**Never commit actual secrets to Git**.

```bash
# Create secret from literal (one-time)
kubectl -n tev1 create secret generic tev1-ws-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -base64 32)" \
  --from-literal=REDIS_PASSWORD="$(openssl rand -base64 32)" \
  --dry-run=client -o yaml | kubectl apply -f -

# Or use sealed-secrets / external-secrets for GitOps
```

## Monitoring

### Prometheus Metrics

- **Port**: 8082 (`/metrics` endpoint)
- **ServiceMonitor**: Auto-discovered by Prometheus Operator
- **Key Metrics**:
  - `websocket_connections` - Active connections per pod
  - `http_requests_total` - HTTP request counters
  - `nodejs_*` - Node.js runtime metrics

### Health Checks

| Probe | Endpoint | Interval |
|-------|----------|----------|
| Liveness | `/health` | 10s |
| Readiness | `/health` | 5s |
| Startup | `/health` | 5s (30 retries) |

## Troubleshooting

### Common Issues

**ImagePullBackOff**:
```bash
# Check image exists and credentials
kubectl -n tev1 describe pod <pod-name>
# Verify GHCR credentials in cluster
```

**Pods Not Spreading Across Zones**:
```bash
# Check node labels
kubectl get nodes --show-labels | grep topology.kubernetes.io/zone
# Verify requiredDuringSchedulingIgnoredDuringExecution in deployment
```

**HPA Not Scaling**:
```bash
# Check metrics server
kubectl top pods -n tev1
# Verify HPA conditions
kubectl -n tev1 describe hpa tev1-ws-hpa
```

**Certificate Issues**:
```bash
# Check cert-manager
kubectl -n tev1 describe certificate
kubectl -n tev1 describe clusterissuer letsencrypt-prod
```

### Useful Commands

```bash
# View rendered manifests
kubectl kustomize server/k8s/overlays/production | less

# Check resource usage
kubectl -n tev1 top pods -l app=tev1-ws

# View logs
kubectl -n tev1 logs -l app=tev1-ws -f --tail=100

# Port forward for debugging
kubectl -n tev1 port-forward svc/tev1-ws 8081:8081

# Exec into pod
kubectl -n tev1 exec -it <pod-name> -- sh
```

## Security Notes

- All containers run as non-root (UID 1001)
- Read-only root filesystem
- Dropped ALL capabilities
- seccompProfile: RuntimeDefault
- ServiceAccount with minimal RBAC
- Network policies recommended (not yet implemented)

## Adding New Environments

```bash
# Create new overlay directory
mkdir -p server/k8s/overlays/staging

# Create kustomization.yaml with staging values
cat > server/k8s/overlays/staging/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: tev1-staging

resources:
  - ../../base

replicas:
  - name: tev1-ws
    count: 2

images:
  - name: tev1-ws
    newTag: "staging-latest"

# Staging-specific patches...
EOF
```

## References

- [Kustomize Documentation](https://kustomize.io/)
- [kubectl kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [cert-manager](https://cert-manager.io/docs/)
- [Prometheus Operator](https://prometheus-operator.dev/)