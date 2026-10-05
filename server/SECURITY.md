# TEV1 보안 모델

## 인증

비밀번호는 **scrypt**(N=16384, r=8, p=1, 128bit salt, 64byte key)로 해시한다.
외부 의존성 없이 Node 내장 `crypto`만 사용하므로 공급망 공격 면이 줄어든다.

```
scrypt$N$r$p$<salt base64>$<hash base64>
```

파라미터를 해시 문자열에 포함하므로 향후 비용을 높일 때 이전 해시도 검증 가능하다.

### 계정 상태
- `is_active`: 관리자가 계정을 비활성화할 수 있다
- `failed_logins` / `locked_until`: 5회 연속 실패 시 15분 잠금
- `locked_until`이 지나면 자동으로 로그인 시도로 재개된다

### 세션
- JWT에 `jti`(세션 ID)를 넣어 **개별 로그아웃**을 지원한다
- JWT 서명 통과 후 DB의 `auth_sessions`에서 폐기/만료 여부를 다시 확인한다
  - 로그아웃, 비밀번호 변경 시 기존 세션이 즉시 무효화된다
- 기본 수명 12시간 (`SESSION_TTL_HOURS`로 조정)

> 주의: DB를 확인할 수 없으면 인증을 통과시키지 않는다(안전 우선).

## 권한

`userId`는 **절대 쿼리스트링·바디에서 받지 않는다.** `requireAuth`가 JWT에서 추출한
값으로 덮어쓴다. 이로써 조직 관리자 API에 쿼리스트링 스푸핑이 불가능하다.

| 역할 | 권한 |
|------|------|
| owner | 전체 + admin/owner 지정 가능 |
| admin | 멤버·방 관리, member/viewer만 변경 가능 |
| member | 방 생성/참가, 멤버 조회 |
| viewer | 읽기 전용 |

- `owner`는 유일한 owner가 강등될 수 없다(조직에 관리자가 없어지는 것을 방지).
- `admin`은 `owner`/`admin` 역할을 변경하거나 부여할 수 없다.

## 입력 검증

- 비밀번호: 10자 이상, 영문 대문자/소문자/숫자 중 2종 이상
- 사용자 ID: 3~64자, 영문/숫자/`.` `_` `@` `-`만
- 조직 슬러그: 3~50자, 소문자/숫자/하이픈
- 메시지: 4000자 잘림
- 모든 입력은 출력 시 HTML 이스케이프된다

## 레이트리밋

외부 의존성 없이 IP 기반 슬라이딩 윈도우로 구현한다.

| 대상 | 한도 |
|------|------|
| 로그인/가입 | 15분에 10회 |
| `/api/*` | 1분에 120회 |
| 초과 응답 | `429` + `Retry-After` 헤더 |

## 외부 연동

- **Google OAuth**: `state`를 HMAC-SHA256으로 서명하고 10분 만료를 적용한다.
  평문 JSON을 쓰면 다른 계정으로 토큰을 연결하는 우회가 가능하다.
- **Web Push**: VAPID 키가 없으면 푸시 API는 `503(PUSH_DISABLED)`을 반환한다.
- **이메일 인증**: 가입 시 인증 토큰을 발급해 메일로 발송하고, `verify-email`에서 1회만 소비한다.
  - 토큰은 SHA-256 해시로만 저장하며 평문은 DB·로그에 남기지 않는다.
  - 재전송·비밀번호 찾기는 계정 존재 여부를 노출하지 않는 동일 메시지를 반환한다(계정 열거 방지).
  - 발송 재사용은 15분에 3회로 제한한다.
  - 비밀번호 재설정 성공 시 해당 사용자의 모든 세션을 즉시 폐기한다.
- **2단계 인증(TOTP)**: RFC 6238, SHA-1, 6자리, 30초 주기, ±1 윈도우 허용.
  - 시크릿은 서버에서만 보관하고 클라이언트로 다시 노출하지 않는다.
  - 복구 코드는 10개를 1회성으로 발급하며 **평문 대신 SHA-256 해시로만 저장**한다.
  - 로그인 시 로그인 실패 횟수를 증가시켜 무차별 대입을 막는다.

## 보안 헤더

`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Content-Security-Policy`, HSTS(HTTPS 시)를 설정한다.

## 메일 발송 모드

SMTP 환경변수(`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM`)를 설정하면 실제 SMTP로 발송한다. 설정이 없으면 개발 편의를 위해
`dev-outbox` 모드로 전환되어 메일이 JSONL 파일(`MAIL_OUTBOX_FILE`)에만 기록된다.

- **운영에서는 dev-outbox을 사용하지 않는다.** 해당 파일에는 인증·재설정 토큰이
  평문으로 남으므로 파일 권한을 제한하고 주기적으로 삭제해야 한다.
- `dev-outbox` 모드는 발송 성공을 가장하지만 실제 수신은 되지 않는다.
  운영 전환 여부는 반드시 환경변수 존재로 판단한다.

## 계정 정책

### 이메일 인증 (기본 강제)

`REQUIRE_EMAIL_VERIFICATION`이 `true`이거나 `NODE_ENV=production`이면 다음이 적용된다.

- **가입 시 이메일 필수**: 없으면 `400 EMAIL_REQUIRED`
- **미인증 계정 로그인 차단**: `403 EMAIL_NOT_VERIFIED`
- 인증 완료(`email_verified_at` 설정) 후 정상 로그인 허용

정책을 끄려면 `REQUIRE_EMAIL_VERIFICATION=false`를 명시한다. 이 경우 이메일이 없는 계정이
생길 수 있으며, 그 계정은 인증 강제 대상이 아니다.

### 레거시 계정 초기화

`password_hash`가 `NULL`인 기존 계정은 로그인이 `403 PASSWORD_SETUP_REQUIRED`로 거부된다.
관리자 개입 없이 아래 플로우로 스스로 해결한다.

1. 로그인 시도 → `403 PASSWORD_SETUP_REQUIRED` + `email: true`
2. `POST /api/auth/setup-password` (아이디 + 이메일) → 7일 유효 링크 발송
3. `POST /api/auth/complete-setup` (토큰 + 새 비밀번호) → 비밀번호 설정 완료

보안 설계:

- 아이디/이메일이 일치하지 않으면 **일반 계정과 동일한 응답**을 반환해 계정 존재를 노출하지 않는다.
- 이미 비밀번호가 있는 계정에는 링크를 발급하지 않고, `complete-setup`에서 `409 ALREADY_SET`으로 방어한다.
- 초기화 시점의 이메일 인증과 기존 세션 폐기를 함께 처리한다.

### 세션 관리

사용자는 자신의 로그인 기기를 확인하고 원격으로 종료할 수 있다.

| 엔드포인트 | 동작 |
|---|---|
| `GET /api/auth/sessions` | 활성/폐기 세션 목록 + 현재 세션 표시 |
| `POST /api/auth/sessions/revoke` | 지정 세션 1개 종료 (본인 계정만) |
| `POST /api/auth/sessions/revoke-others` | 현재 기기 외 전부 종료 |
| `POST /api/auth/change-password` | 기본: 전체 세션 폐기. `revokeOthers:false`면 현재 세션 유지 |

세션을 폐기하는 보안 이벤트는 아래 4가지다.

- 로그아웃 (`/api/auth/logout`)
- 비밀번호 재설정 (토큰 경로)
- 비밀번호 변경 (`revokedAllSessions` 기본 `true`)
- 2FA 해제 (현재 세션만 유지, 다른 기기는 재인증)

## 알려진 제한

- **`/metrics`는 인증 없음**: 내부망에 격리하거나 프록시에서 인증을 적용해야 한다.
  (`METRICS_TOKEN` 지원)
- **`token` 쿼리 파라미터로 토큰 전달 방식**: 프론트가 이 방식을 쓰면 브라우저 히스토리·
  로그에 인증 토큰이 남을 수 있다. Authorization 헤더만 사용한다.
- **TOTP 시크릿은 QR과 텍스트로 함께 제공**: `otpauth://` URI를 서버에서 인라인 SVG QR로
  생성해 반환한다. 외부 이미지 요청이 없으므로 CSP·프록시 설정과 무관하게 동작한다.
  QR 스캔이 불가능한 환경 대비로 시크릿 직접 입력 경로도 함께 제공한다.
  - SVG는 픽셀 `<path>`로만 인코딩되어 원문이 HTML에 삽입되지 않는다.
  - 방어적으로 `<script>`/`on*=`/`javascript:` 패턴이 섞이면 폐기하고 텍스트 경로로 폴백한다.
  - `otpauth://` URI에 전자서명 카운터(`digital_signature`)는 넣지 않는다. 신원확인이 아닌
    로그인용 TOTP이므로 불필요하며, 인증앱 간 호환성을 해친다.
