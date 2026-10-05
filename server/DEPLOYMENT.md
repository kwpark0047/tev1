# TEV1 Server - Production Deployment Guide

## 개요
TEV1 프로젝트의 프로덕션 배포를 위한 Docker, Kubernetes, CI/CD 파이프라인 설정 문서입니다.

## 아키텍처

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Client        │────▶│   Nginx (TLS)    │────▶│   TEV1 App      │
│   (Browser)     │     │   (Reverse Proxy)│     │   (Node.js)     │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                              ┌───────────────────────────┼───────────────────────────┐
                              ▼                           ▼                           ▼
                        ┌───────────────┐           ┌───────────────┐           ┌───────────────┐
                        │  PostgreSQL   │           │    Redis      │           │  Monitoring   │
                        │   (Primary)   │           │   (Cache)     │           │  (Prometheus) │
                        └───────────────┘           └───────────────┘           └───────────────┘
```

## 사전 요구사항

- Docker 24+ & Docker Compose 2+
- Kubernetes 1.28+ (프로덕션)
- kubectl, helm 3+
- 도메인 및 DNS 설정 (tev1.example.com)
- GitHub Container Registry (GHCR) 접근 권한

## 로컬 개발 환경

```bash
# 저장소 클론
git clone https://github.com/your-org/tev1.git
cd tev1/server

# 환경 변수 설정
cp .env.example .env
# .env 편집하여 실제 값 입력

# 서비스 시작
docker compose up -d

# 로그 확인
docker compose logs -f app

# 헬스체크
curl http://localhost:8081/health
curl http://localhost:8081/health/detailed
```

## 프로덕션 배포 (Kubernetes)

### 1. 네임스페이스 및 시크릿 생성

```bash
# 네임스페이스 생성
kubectl apply -f k8s/namespace.yaml

# 시크릿 생성 (실제 값으로 변경 필요)
kubectl create secret generic tev1-secrets \
  --namespace=tev1 \
  --from-literal=DATABASE_URL="postgresql://tev1:PASSWORD@tev1-postgres:5432/tev1" \
  --from-literal=JWT_SECRET="YOUR_SECURE_JWT_SECRET" \
  --from-literal=GOOGLE_CLIENT_ID="YOUR_GOOGLE_CLIENT_ID" \
  --from-literal=GOOGLE_CLIENT_SECRET="YOUR_GOOGLE_CLIENT_SECRET" \
  --from-literal=VAPID_PUBLIC_KEY="YOUR_VAPID_PUBLIC_KEY" \
  --from-literal=VAPID_PRIVATE_KEY="YOUR_VAPID_PRIVATE_KEY" \
  --from-literal=POSTGRES_PASSWORD="YOUR_POSTGRES_PASSWORD"
```

### 2. ConfigMap 및 리소스 배포

```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/services.yaml
kubectl apply -f k8s/hpa-pdb.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/servicemonitor.yaml
```

### 3. 인증서 발급 (Cert-Manager)

```bash
# Cert-Manager 설치 (없는 경우)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml

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
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
EOF
```

### 4. 배포 확인

```bash
# 파드 상태 확인
kubectl get pods -n tev1 -w

# 서비스 확인
kubectl get svc -n tev1

# 인그레스 확인
kubectl get ingress -n tev1

# 로그 확인
kubectl logs -n tev1 -l app=tev1,component=server -f

# 헬스체크
curl https://tev1.example.com/health
curl https://tev1.example.com/health/detailed
```

## 환경 변수 참조

| 변수 | 필수 | 설명 | 예시 |
|------|------|------|------|
| DATABASE_URL | O | PostgreSQL 연결 문자열 | `postgresql://user:pass@host:5432/db` |
| REDIS_URL | O | Redis 연결 문자열 | `redis://host:6379` |
| JWT_SECRET | O | JWT 서명 키 (32자 이상) | `super-secret-key-32-chars-min` |
| GOOGLE_CLIENT_ID | X | Google OAuth 클라이언트 ID | `123456789-abc.apps.googleusercontent.com` |
| GOOGLE_CLIENT_SECRET | X | Google OAuth 클라이언트 시크릿 | `GOCSPX-xxxxx` |
| GOOGLE_REDIRECT_URI | X | OAuth 리다이렉트 URI | `https://tev1.example.com/api/auth/google/callback` |
| VAPID_PUBLIC_KEY | X | Web Push VAPID 공개 키 | `BEl62iUYgUivxIkv69yViEuiBIa40HI80NM9fY7s5eDg8qVhKsLGhQ9k5z` |
| VAPID_PRIVATE_KEY | X | Web Push VAPID 개인 키 | `your-private-key` |
| SMTP_HOST | X | SMTP 서버 (미설정 시 dev-outbox) | `smtp.example.com` |
| SMTP_PORT | X | SMTP 포트 (TLS는 465) | `587` |
| SMTP_SECURE | X | STARTTLS 대신 직접 TLS 사용 여부 | `false` |
| SMTP_USER | X | SMTP 계정 | `tev1@example.com` |
| SMTP_PASS | X | SMTP 비밀번호 | - |
| MAIL_FROM | X | 발신자 표시 주소 | `tev1@example.com` |
| MAIL_OUTBOX_FILE | - | dev-outbox 저장 경로(개발 전용) | `/tmp/tev1-outbox.jsonl` |
| REQUIRE_EMAIL_VERIFICATION | - | 이메일 인증 강제 (production이면 기본 true) | `true` |
| METRICS_TOKEN | - | `/metrics` 접근 시 요구할 베어러 토큰 | `random-token` |
| FRONTEND_URL | O | 프론트엔드 URL (메일 링크 생성에 사용) | `https://tev1.example.com` |
| CORS_ORIGIN | O | CORS 허용 오리진 | `https://tev1.example.com` |
| NODE_ENV | O | 실행 환경 | `production` |
| PORT | O | 서버 포트 | `8081` |

## 모니터링 & 알림

### Prometheus 메트릭 엔드포인트
- `/metrics` - Prometheus 스크랩용
- `/health` - 기본 헬스체크
- `/health/detailed` - 상세 헬스체크 (DB, Redis, Pool 상태)

### Grafana 대시보드
`k8s/servicemonitor.yaml`의 ConfigMap에 정의된 대시보드가 자동으로 Grafana에 프로비저닝됩니다.

### 주요 알림 규칙 예시

```yaml
groups:
  - name: tev1-alerts
    rules:
      - alert: TEV1HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "TEV1 High Error Rate"
      
      - alert: TEV1HighMemoryUsage
        expr: (container_memory_usage_bytes / container_spec_memory_limit_bytes) > 0.9
        for: 10m
        labels:
          severity: warning
```

## 백업 & 재해 복구

### PostgreSQL 백업

```bash
# 일일 백업 CronJob
cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup
  namespace: tev1
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: postgres:16
              command: ["/bin/sh", "-c"]
              args:
                - pg_dump -h tev1-postgres -U tev1 tev1 | gzip > /backup/tev1-$(date +%F).sql.gz
              env:
                - name: PGPASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: tev1-secrets
                      key: POSTGRES_PASSWORD
              volumeMounts:
                - name: backup
                  mountPath: /backup
          volumes:
            - name: backup
              persistentVolumeClaim:
                claimName: backup-pvc
          restartPolicy: OnFailure
EOF
```

## 롤백 절차

```bash
# 이전 버전으로 롤백
kubectl rollout undo deployment/tev1-app -n tev1

# 특정 리비전으로 롤백
kubectl rollout undo deployment/tev1-app -n tev1 --to-revision=3

# 롤백 상태 확인
kubectl rollout status deployment/tev1-app -n tev1
```

## 트러블슈팅

### 파드가 CrashLoopBackOff인 경우
```bash
kubectl logs -n tev1 -l app=tev1 --previous
kubectl describe pod -n tev1 -l app=tev1
```

### DB 연결 실패
```bash
# 시크릿 확인
kubectl get secret tev1-secrets -n tev1 -o yaml

# PostgreSQL 파드 상태
kubectl get pods -n tev1 -l app=tev1,component=postgres
```

### 인그레스 502 에러
```bash
# 서비스 엔드포인트 확인
kubectl get endpoints -n tev1

# 인그레스 컨트롤러 로그
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx
```

## 보안 체크리스트

- [ ] 모든 시크릿이 Kubernetes Secrets로 관리됨
- [ ] TLS 1.2+ 강제 적용
- [ ] HSTS 헤더 설정됨
- [ ] CSP 헤더 설정됨
- [ ] Rate Limiting 적용됨
- [ ] 네트워크 폴리시로 파드 간 통신 제한
- [ ] Pod Security Standards (restricted) 적용
- [ ] 정기적인 취약점 스캔 (Trivy, Snyk)
- [ ] 의존성 자동 업데이트 (Dependabot/Renovate)
- [ ] 감사 로그 활성화 및 모니터링

## 참고 자료

- [Docker Best Practices](https://docs.docker.com/develop/develop-images/dockerfile_best-practices/)
- [Kubernetes Production Checklist](https://kubernetes.io/docs/setup/best-practices/)
- [NGINX Ingress Controller](https://kubernetes.github.io/ingress-nginx/)
- [Cert-Manager](https://cert-manager.io/docs/)
- [Prometheus Operator](https://prometheus-operator.dev/)
---

## 로컬 환경 구성 (root 권한 없는 경우)

Docker가 없는 환경에서는 사용자 영역에 직접 설치할 수 있다.

### PostgreSQL

```bash
sudo apt-get install -y postgresql-16 postgresql-client-16   # root 사용 가능 시
# 또는 사용자 영역 설치
mkdir -p /tmp/pgsetup && cd /tmp/pgsetup
apt-get download postgresql-16 postgresql-client-16 postgresql-common \
  postgresql-client-common libpq5 libllvm18 libicu74 libssl3t64 libreadline8t64
for f in *.deb; do dpkg -x "$f" root; done
export PGBIN=/tmp/pgsetup/root/usr/lib/postgresql/16/bin
export PGDATA=/tmp/pgdata
export LD_LIBRARY_PATH=/tmp/pgsetup/root/usr/lib/x86_64-linux-gnu
$PGBIN/initdb -D $PGDATA -U tev1 --auth=trust -E UTF8 --locale=C
$PGBIN/postgres -D $PGDATA -p 5432 -k $PGDATA &
$PGBIN/psql -h 127.0.0.1 -U tev1 -d postgres -c "CREATE DATABASE tev1 OWNER tev1;"
$PGBIN/psql -h 127.0.0.1 -U tev1 -d postgres -c "ALTER DATABASE tev1 SET timezone TO 'UTC';"
```

> **시간대 주의**: 애플리케이션은 UTC ISO 문자열을 보낸다. DB를 UTC로 고정해야
> `created_at` 비교가 어긋나지 않는다. (애플리케이션이 최초 기동 시
> `timestamp` → `timestamptz` 마이그레이션을 자동 수행한다)

### Redis

```bash
curl -sL -o redis.tar.gz https://github.com/redis/redis/archive/refs/tags/7.4.2.tar.gz
tar xzf redis.tar.gz && cd redis-7.4.2
make -j4 MALLOC=libc redis-server redis-cli
./src/redis-server --port 6379 --bind 127.0.0.1 --save '' --appendonly no &
```

### 검증

```bash
cd server
npm test                        # 프론트 9항목 + 서버 33항목
TEV1_SKIP_DB=1 npm run test:smoke   # DB 없이 degradation 경로 17항목
```

## 프론트엔드 서버 주소 설정

프론트엔드는 서버 주소가 하드코딩되어 있지 않다. 다음 우선순위로 해석한다.

1. `window.__TEV1__ = { serverUrl: 'https://api.tev1.example.com' }` (배포 인젝션 권장)
2. `window.TEV1_SERVER_URL` (인라인 스크립트 선언)
3. `<meta name="tev1-server-url" content="https://...">`
4. 위가 모두 없으면 **현재 origin과 동일**하게 연결 (리버스 프록시 권장)

빈 값이면 상대경로로 동작하므로, API와 Socket.IO가 같은 도메인에 있으면 별도 설정이 없다.

개발 시 인라인 선언 예시:

```html
<script>window.TEV1_SERVER_URL = 'http://localhost:8081';</script>
```

Nginx 리버스 프록시 예시(`/socket.io/` Upgrade 헤더를 반드시 전달):

```nginx
location /socket.io/ {
    proxy_pass http://127.0.0.1:8081;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 메일 발송 (SMTP) 설정

이메일 인증·비밀번호 재설정·초대 메일은 SMTP 설정이 없으면 개발용 `dev-outbox` 모드로
동작한다. 운영에서는 반드시 아래 변수를 설정한다.

```bash
MAIL_FROM="tev1@example.com"
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_SECURE="false"     # 465 포트를 쓰면 true
SMTP_USER="tev1@example.com"
SMTP_PASS="app-password"
FRONTEND_URL="https://tev1.example.com"
```

주의 사항:

- `dev-outbox`은 발송 성공으로 간주되지만 실제 메일이 도착하지 않는다.
  메일 발송을 확인해야 하는 QA는 반드시 SMTP를 설정한 환경에서 수행한다.
- outbox JSONL에는 인증·재설정 토큰이 평문으로 남는다. 운영에서는 이 모드를 쓰지 않는다.
- `FRONTEND_URL`이 실제 도메인과 다르면 인증/재설정 링크가 엉뚱한 주소로 발급된다.

## Web Push VAPID 키 생성

```bash
node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
```

생성된 키 쌍을 `.env`에 설정한다. 미설정 시 푸시 API는 503
(`PUSH_DISABLED`)을 반환하며 서버는 정상 기동한다.
