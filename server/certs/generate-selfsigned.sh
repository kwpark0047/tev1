#!/bin/bash
# 개발용 자체 서명 인증서 생성

set -e

DOMAIN="ws.tev1.example.com"
NAMESPACE="tev1"
CERT_DIR="./certs"

mkdir -p certs

echo "=== 개발용 자체 서명 인증서 생성 ==="

# 개인키 생성
openssl genrsa -out ${CERT_DIR}/tls.key 2048

# CSR 생성
openssl req -new -key ${CERT_DIR}/tls.key -out ${CERT_DIR}/tls.csr -subj "/CN=ws.tev1.example.com/O=TEV1/OU=Development"

# 자체 서명 인증서 생성 (1년 유효)
openssl x509 -req -in ${CERT_DIR}/tls.csr -signkey ${CERT_DIR}/tls.key -out ${CERT_DIR}/tls.crt -days 365 -extensions v3_req -extensions v3_req -config <(
cat <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = ws.tev1.example.com
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = ws.tev1.example.com
DNS.2 = api.tev1.example.com
DNS.3 = localhost
EOF
)

# Kubernetes TLS Secret 생성
kubectl create secret tls tev1-tls-secret \
  --cert=certs/tls.crt \
  --key=certs/tls.key \
  -n tev1 \
  --dry-run=client -o yaml | kubectl apply -f -

echo "=== 자체 서명 인증서 생성 완료 ==="
echo "인증서 위치: ${CERT_DIR}/tls.crt"
echo "개인키 위치: ${CERT_DIR}/tls.key"
echo "Kubernetes Secret: tev1-tls-secret (namespace: tev1)"