#!/bin/bash
# TLS 인증서 생성 스크립트
# Let's Encrypt 사용 또는 자체 서명 인증서 생성

set -e

DOMAIN=${1:-"ws.tev1.example.com"}
EMAIL=${2:-"admin@tev1.example.com"}
NAMESPACE=${3:-"tev1"}

echo "=== TLS 인증서 생성 시작 ==="
echo "Domain: $DOMAIN"
echo "Email: $EMAIL"
echo "Namespace: $NAMESPACE"

# cert-manager가 설치되어 있는지 확인
if ! kubectl get crd certificates.cert-manager.io &> /dev/null; then
    echo "cert-manager가 설치되지 않았습니다. 설치 중..."
    kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
    kubectl wait --for=condition=ready pod -l app=cert-manager -n cert-manager --timeout=120s
fi

# ClusterIssuer 생성
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@tev1.example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - http01:
        ingress:
          class: nginx
EOF

# Certificate 리소스 생성
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: tev1-tls-secret
  namespace: tev1
spec:
  secretName: tev1-tls-secret
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - ws.tev1.example.com
    - api.tev1.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  duration: 2160h # 90일
  renewBefore: 360h # 15일 전 갱신
EOF

echo "=== 인증서 생성 요청 완료 ==="
echo "상태 확인: kubectl get certificate -n tev1 tev1-tls-secret"
echo "인증서 발급 대기 중..."

# 인증서 발급 대기
kubectl wait --for=condition=Ready certificate/tev1-tls-secret -n tev1 --timeout=300s

# TLS 시크릿 확인
kubectl get secret tev1-tls-secret -n tev1 -o yaml

echo "=== TLS 인증서 생성 완료 ==="