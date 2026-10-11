# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2025-10-12

### Changed
- **k8s/base**: Cleaned up base Kubernetes manifests
  - Removed duplicate `LOG_LEVEL: "info"` in configmap.yaml
  - Removed trailing `configMapGenerator`/`secretGenerator` sections and EOF markers in kustomization.yaml
- **wemarket1**: Updated PWA frontend
  - Reduced EXAMPLES from 10 to 8 items
  - Added detailed information to example items (order numbers, payment amounts, error logs)
  - Removed `"framework": "none"` from vercel.json
  - Added `.gitignore` for frontend-specific ignores

### Added
- `wemarket1/.gitignore` - Git ignore rules for frontend
- `wemarket1/README.md` - PWA frontend documentation
- `PROJECT_SUMMARY.md` - Comprehensive project overview
- `CHANGELOG.md` - Project changelog

### Infrastructure
- Kubernetes manifests using Kustomize (base + production overlays)
- GitHub Actions CI/CD pipeline for automated production deployment
- Prometheus + Grafana monitoring setup
- cert-manager for TLS certificate management
- nginx-ingress for traffic routing
