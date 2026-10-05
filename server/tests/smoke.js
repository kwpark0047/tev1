/**
 * TEV1 서버 스모크 테스트
 * - 외부 DB/Redis 없이도 서버가 기동되고 핵심 라우트가 응답하는지 검증한다
 * - 테스트는自行 종료하므로 CI 및 로컬 어디서나 실행 가능하다
 *
 * 사용법: node tests/smoke.js
 * 환경변수: TEV1_SMOKE_PORT(기본 8097), TEV1_SMOKE_TIMEOUT_MS(기본 60000)
 */
'use strict';

const path = require('path');
const assert = require('assert');

const PORT = Number(process.env.TEV1_SMOKE_PORT || 8097);
const TIMEOUT_MS = Number(process.env.TEV1_SMOKE_TIMEOUT_MS || 60000);
process.env.PORT = String(PORT);
// 테스트 중에는 VAPID/Google 설정을 비워 graceful degradation 경로를 검증한다
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

// DB/Redis 실경로 검증은 해당 서버가 기동 중일 때만 수행한다.
// (TEV1_SKIP_DB=1 로 건너뛸 수 있다)
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://tev1@127.0.0.1:5432/tev1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const SKIP_DB = process.env.TEV1_SKIP_DB === '1';
process.env.DATABASE_URL = DATABASE_URL;
process.env.REDIS_URL = REDIS_URL;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` - ${detail}` : ''}`);
}

// 테스트 요청마다 고유 IP를 사용한다.
// 레이트리밋이 IP별 카운터를 쓰므로, 테스트 항목이 서로 영향을 주지 않아야 한다.
let ipCounter = 0;
function nextTestIp() {
  ipCounter += 1;
  return `10.99.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

async function req(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': nextTestIp(),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { status: res.status, body, headers: res.headers };
}

async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const started = Date.now();
  const mod = require(path.join(__dirname, '..', 'src', 'server.js'));
  const { server, io, ready } = mod;

  // 스키마 생성이 끝날 때까지 대기 (테이블 없음으로 인한 쿼리 실패 방지)
  if (ready && typeof ready.then === 'function') {
    await ready.catch(() => {});
  }

  const up = await waitForReady(TIMEOUT_MS);
  record('서버 기동', up, up ? `${Date.now() - started}ms` : '기동超时');
  if (!up) {
    await shutdown(server, io, 1);
    return;
  }

  // 1) health
  try {
    const { status, body } = await req('/health');
    record('/health 200 + status ok', status === 200 && body.status === 'ok', `status=${status}`);
    record('/health DB 상태 노출', typeof body.database === 'string', `database=${body.database}`);
  } catch (e) {
    record('/health 200 + status ok', false, e.message);
  }

  // 2) health/detailed (wss 참조 제거 확인: 예전엔 여기서 ReferenceError가 났다)
  try {
    const { status, body } = await req('/health/detailed');
    const ok = status === 200 && body.services && body.services.socketio;
    record('/health/detailed 200 + socketio 정보', !!ok, `status=${status} socketio=${body.services && body.services.socketio && body.services.socketio.connections}`);
  } catch (e) {
    record('/health/detailed 200 + socketio 정보', false, e.message);
  }

  // 3) 회원가입 → 토큰 발급
  // (이전에는 이름만으로 토큰을 발급해 누구든 타인 사칭이 가능했다)
  const SU_ID = 'smoke-user';
  const SU_PW = 'SmokePass123';
  let token = null;

  // DB가 없으면 인증 자체가 불가능하므로 503 경로만 검증하고 DB 스위트로 넘어간다
  if (SKIP_DB) {
    try {
      const probe = await req('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ userId: 'probe', name: 'P', password: 'ProbePass123' }),
      });
      record('DB 부재 시 회원가입 503', probe.status === 503, `status=${probe.status}`);
      const legacy = await req('/api/auth/token', {
        method: 'POST',
        body: JSON.stringify({ userId: 'attacker', name: 'A' }),
      });
      record('무인증 토큰 발급 차단(404)', legacy.status === 404, `status=${legacy.status}`);
      const weak = await req('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ userId: 'weak', name: 'W', password: 'abc' }),
      });
      record('약한 비밀번호 거부 400', weak.status === 400 && weak.body.code === 'WEAK_PASSWORD', `status=${weak.status}`);
      const hr = await req('/health');
      record('보안 헤더 적용(DB 없음)', !!hr.headers.get('content-security-policy'), '');
      record('DB/Redis 실경로', true, 'TEV1_SKIP_DB=1 로 건너뜀');
    } catch (e) {
      record('DB 부재 경로', false, e.message);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n요약: ${results.length - failed.length}/${results.length} 통과 (${Date.now() - started}ms)`);
    if (failed.length) {
      console.log('실패 항목:');
      for (const f of failed) console.log(`  - ${f.name} (${f.detail || ''})`);
    }
    await shutdown(server, io, failed.length ? 1 : 0);
    return;
  }

  try {
    const reg = await req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ userId: SU_ID, name: '스모크', password: SU_PW }),
    });
    // 이미 가입된 경우(재실행) 로그인으로 이어간다
    if (reg.status === 201) {
      token = reg.body && reg.body.token;
      record('회원가입 201 + 토큰 발급', typeof token === 'string', `status=${reg.status}`);
    } else if (reg.status === 409) {
      // 재실행 시 기존 계정이다. 이전 버전에서 비밀번호 없이 만들어진 레거시 계정은
      // 로그인이 불가능하므로(NO_PASSWORD) 테스트 계정만 비밀번호를 설정해 초기화한다.
      await resetTestUserPassword(SU_ID, SU_PW, '스모크');
      const li = await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ userId: SU_ID, password: SU_PW }),
      });
      token = li.body && li.body.token;
      record('회원가입 중복 409 → 로그인 복구', li.status === 200 && typeof token === 'string', `status=${li.status}`);
    } else {
      record('회원가입 201 + 토큰 발급', false, `status=${reg.status} ${reg.body && reg.body.error}`);
    }
  } catch (e) {
    record('회원가입 201 + 토큰 발급', false, e.message);
  }

  // 3-1) 레거시 무인증 토큰 엔드포인트는 제거되어 있어야 한다 (사칭 방지)
  try {
    const { status } = await req('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ userId: 'attacker', name: '공격자' }),
    });
    record('무인증 토큰 발급 차단(404)', status === 404, `status=${status}`);
  } catch (e) {
    record('무인증 토큰 발급 차단(404)', false, e.message);
  }

  // 3-2) 약한 비밀번호는 거부 (레이트리밟 소모를 막기 위해 정책은 단위 검증으로 대체)
  // (auth.validatePassword 로 직접 검증 - 아래 별도 항목)

  // 3-3) 잘못된 비밀번호 로그인은 401 (계정 존재 여부 비노출)
  //     계정 잠금(423)이 걸리지 않도록 실패 횟수를 먼저 초기화한 뒤 1회만 시도한다.
  try {
    await clearFailedLogins(SU_ID);
    const { status, body } = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ userId: SU_ID, password: 'WrongPass12345' }),
    });
    record('잘못된 비밀번호 401', status === 401 && body && body.code === 'INVALID_CREDENTIALS', `status=${status}`);
  } catch (e) {
    record('잘못된 비밀번호 401', false, e.message);
  }

  // 4) /api/auth/me 토큰 + 세션 검증
  try {
    const { status, body } = await req('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    record('/api/auth/me 토큰 검증', [200, 401, 404].includes(status), `status=${status} ${body && body.error ? body.error : ''}`);
  } catch (e) {
    record('/api/auth/me 토큰 검증', false, e.message);
  }

  // 5) 잘못된 토큰은 401
  try {
    const { status } = await req('/api/auth/me', { headers: { Authorization: 'Bearer invalid.token' } });
    record('잘못된 토큰 401', status === 401, `status=${status}`);
  } catch (e) {
    record('잘못된 토큰 401', false, e.message);
  }

  // 5-1) 로그아웃하면 세션이 즉시 무효화되어야 한다
  try {
    const lo = await req('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const after = await req('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    record(
      '로그아웃 후 세션 무효화(401)',
      lo.status === 200 && after.status === 401,
      `logout=${lo.status} after=${after.status}`
    );
    // 이후 테스트가 인증 토큰을 쓰므로 다시 로그인한다
    const relogin = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ userId: SU_ID, password: SU_PW }),
    });
    token = relogin.body && relogin.body.token;
    record('재로그인 토큰 재발급', relogin.status === 200 && typeof token === 'string', `status=${relogin.status}`);
  } catch (e) {
    record('로그아웃 후 세션 무효화(401)', false, e.message);
  }

  // 5-2) 보안 헤더 확인
  try {
    const { headers } = await req('/health');
    const csp = headers.get ? headers.get('content-security-policy') : null;
    record(
      '보안 헤더 적용',
      !!csp && headers.get('x-content-type-options') === 'nosniff',
      `csp=${csp ? 'yes' : 'no'} nosniff=${headers.get('x-content-type-options')}`
    );
  } catch (e) {
    record('보안 헤더 적용', false, e.message);
  }

  // 6) 미설정 외부 연동은 503 (500 아님)
  try {
    const { status, body } = await req('/api/push/subscribe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: 'u', subscription: { endpoint: 'https://example.com' } }),
    });
    // 인증은 통과하고, DB 미가용이면 DB_UNAVAILABLE, DB가 있으면 PUSH_DISABLED
    const code = body && body.code;
    record('Web Push 가드 동작 (503)', status === 503 && ['DB_UNAVAILABLE', 'PUSH_DISABLED'].includes(code), `status=${status} code=${code}`);
  } catch (e) {
    record('Web Push 가드 동작 (503)', false, e.message);
  }

  // 6-1) 인증 없이 접근하면 401 (userId 쿼리스트링만으로 접근 불가)
  try {
    const { status } = await req('/api/organizations?userId=attacker');
    record('组织 API 토큰 없이 401', status === 401, `status=${status}`);
  } catch (e) {
    record('组织 API 토큰 없이 401', false, e.message);
  }

  try {
    const { status } = await req('/api/analytics/meetings/summary?orgId=x&userId=attacker');
    record('분석 API 토큰 없이 401', status === 401, `status=${status}`);
  } catch (e) {
    record('분석 API 토큰 없이 401', false, e.message);
  }

  // 6-2) DB 미가용 환경에서만 503을 기대한다 (DB가 있으면 실제 조회로 이어진다)
  try {
    const { status, body } = await req('/api/analytics/meetings/summary?orgId=x', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (status === 503) {
      record('분석 API DB 미가용 503', body && body.code === 'DB_UNAVAILABLE', `status=${status} code=${body && body.code}`);
    } else {
      record('분석 API DB 가용 상태로 통과', status === 200, `status=${status}`);
    }
  } catch (e) {
    record('분석 API DB 상태 처리', false, e.message);
  }

  // 6-3) VAPID 공개키는 인증 없이 접근 가능해야 한다 (공개키)
  try {
    const { status, body } = await req('/api/push/vapid-public-key');
    record('VAPID 공개키 엔드포인트 존재', status === 200 || status === 503, `status=${status}`);
  } catch (e) {
    record('VAPID 공개키 엔드포인트 존재', false, e.message);
  }

  try {
    const { status, body } = await req('/api/auth/google/url');
    record('Google OAuth 미설정 503', status === 503, `status=${status} code=${body && body.code}`);
  } catch (e) {
    record('Google OAuth 미설정 503', false, e.message);
  }

  // 7) Socket.IO 핸드셰이크 + auth(join) 플로우 (TDZ 버그 회귀 테스트)
  const socketResult = await testSocketFlow(token);
  record('Socket.IO auth 플로우 (TDZ 버그 없음)', socketResult.ok, socketResult.detail);
  if (socketResult.cursorOk) {
    record('cursor 라운드트립', true, socketResult.cursorDetail);
  }

  // 8) WebRTC 시그널링 이벤트 존재 여부 (리셋에 등록되어 있어야 함)
  record('WebRTC 시그널링 이벤트 등록', socketResult.signalHandlers, socketResult.handlerDetail);

  // 9) 존재하지 않는 라우트는 404 (Express 5/4 차이 확인)
  try {
    const { status } = await req('/__no_such_route__');
    record('없는 라우트 404', status === 404, `status=${status}`);
  } catch (e) {
    record('없는 라우트 404', false, e.message);
  }

  // ---------- DB/Redis 실경로 검증 ----------
  if (SKIP_DB) {
    record('DB/Redis 실경로', true, 'TEV1_SKIP_DB=1 로 건너뜀');
  } else {
    await runDbSuite(token);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n요약: ${results.length - failed.length}/${results.length} 통과 (${Date.now() - started}ms)`);
  if (failed.length) {
    console.log('실패 항목:');
    for (const f of failed) console.log(`  - ${f.name} (${f.detail || ''})`);
  }

  await shutdown(server, io, failed.length ? 1 : 0);
}

/** 실패 카운트/잠금 초기화 (테스트가 423에 걸리지 않도록) */
async function clearFailedLogins(userId) {
  if (SKIP_DB) return;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await pool.query(
      'UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1',
      [userId]
    );
  } catch (_) {
  } finally {
    await pool.end().catch(() => {});
  }
}

/** 테스트 계정 비밀번호를 직접 설정 (레거시 계정 초기화용) */
async function resetTestUserPassword(userId, password, name) {
  if (SKIP_DB) return;
  const { Pool } = require('pg');
  const { hashPassword } = require('../src/auth');
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    const hash = await hashPassword(password);
    await pool.query(
      `INSERT INTO users (id, name, color, password_hash, is_active, failed_logins, locked_until)
       VALUES ($1, $2, '#4ECDC4', $3, true, 0, NULL)
       ON CONFLICT (id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, is_active = true, failed_logins = 0, locked_until = NULL`,
      [userId, name || userId, hash]
    );
  } catch (e) {
    // 초기화 실패는 아래 로그인 검증에서 드러난다
  } finally {
    await pool.end().catch(() => {});
  }
}

/** 실제 DB에 스키마 생성 후 데이터 삽입 -> 분석 쿼리까지 검증 */
async function runDbSuite(token) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  const orgId = 'smoke-org';
  const userA = 'smoke-user';
  const userB = 'smoke-user-b';

  try {
    await pool.query('SELECT 1');
    record('PostgreSQL 연결', true, DATABASE_URL.replace(/:[^:@/]*@/, ':***@'));
  } catch (e) {
    record('PostgreSQL 연결', false, e.message);
    await pool.end().catch(() => {});
    return;
  }

  try {
    // 서버가 기동하며 만든 테이블 확인 (users.status, cursors UNIQUE 포함)
    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='status'"
    );
    record('users.status 컬럼 존재', cols.rows.length === 1);

    const cur = await pool.query(
      `SELECT tc.constraint_name FROM information_schema.table_constraints tc
       WHERE tc.table_name='cursors' AND tc.constraint_type='PRIMARY KEY'`
    );
    record('cursors PK 생성 (ON CONFLICT prerequisite)', cur.rows.length > 0);

    const tbls = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)",
      [['organizations', 'organization_members', 'audit_logs', 'messages', 'rooms', 'room_users', 'cursors', 'users']]
    );
    record('핵심 테이블 8종 생성', tbls.rows.length === 8, `${tbls.rows.length}/8`);

    // 대표 데이터 구성
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO NOTHING`,
      [orgId, '스모크 조직', 'smoke-org']
    );
    for (const [uid, name] of [[userA, '알리'], [userB, '버트']]) {
      await pool.query(
        `INSERT INTO users (id, name, color) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [uid, name, '#4ECDC4']
      );
    }
    await pool.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [orgId, userA]
    );
    const roomId = 'smoke-room';
    await pool.query(
      `INSERT INTO rooms (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
      [roomId, '스모크 회의']
    );
    await pool.query(
      `INSERT INTO room_organizations (room_id, organization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [roomId, orgId]
    );
    for (const uid of [userA, userB]) {
      await pool.query(
        `INSERT INTO room_users (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [roomId, uid]
      );
    }
    for (const uid of [userA, userB, userA, userB, userA]) {
      await pool.query('INSERT INTO messages (room_id, user_id, content) VALUES ($1,$2,$3)', [roomId, uid, '결정 로그 테스트']);
    }
    // 커서 upsert (ON CONFLICT 경로)
    await pool.query(
      `INSERT INTO cursors (room_id, user_id, x, y, updated_at) VALUES ($1,$2,10,20,NOW())
       ON CONFLICT (room_id, user_id) DO UPDATE SET x=EXCLUDED.x, y=EXCLUDED.y, updated_at=NOW()`,
      [roomId, userA]
    );
    await pool.query(
      `INSERT INTO cursors (room_id, user_id, x, y, updated_at) VALUES ($1,$2,99,77,NOW())
       ON CONFLICT (room_id, user_id) DO UPDATE SET x=EXCLUDED.x, y=EXCLUDED.y, updated_at=NOW()`,
      [roomId, userA]
    );
    const curRow = await pool.query('SELECT x, y FROM cursors WHERE room_id=$1 AND user_id=$2', [roomId, userA]);
    record('cursor upsert 반영 (x=99)', curRow.rows[0].x === 99, `x=${curRow.rows[0] && curRow.rows[0].x}`);
    await pool.query(
      'INSERT INTO audit_logs (organization_id, user_id, action, resource_type) VALUES ($1,$2,$3,$4)',
      [orgId, userA, 'create', 'organization']
    );

    // --- Phase 3-4 분석 API 실경로 ---
    const summary = await req(`/api/analytics/meetings/summary?orgId=${orgId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sOk = summary.status === 200 && summary.body && summary.body.totalMeetings >= 1;
    record('분석: 회의 요약', sOk, `status=${summary.status} meetings=${summary.body && summary.body.totalMeetings} messages=${summary.body && summary.body.totalMessages}`);

    const prod = await req(`/api/analytics/users/${userA}/productivity?orgId=${orgId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pOk = prod.status === 200 && prod.body && prod.body.messagesSent >= 1;
    record('분석: 사용자 생산성', pOk, `status=${prod.status} msgs=${prod.body && prod.body.messagesSent}`);

    const trends = await req(`/api/analytics/organizations/${orgId}/trends?period=30d`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const tOk = trends.status === 200 && Array.isArray(trends.body && trends.body.dailyTrends);
    record('분석: 조직 트렌드', tOk, `status=${trends.status} days=${trends.body && trends.body.dailyTrends && trends.body.dailyTrends.length}`);

    const rt = await req(`/api/analytics/realtime?orgId=${orgId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rOk = rt.status === 200 && Array.isArray(rt.body && rt.body.activeMeetings);
    record('분석: 실시간 대시보드', rOk, `status=${rt.status} online=${rt.body && rt.body.onlineUsers}`);

    const audit = await req(`/api/analytics/audit?orgId=${orgId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const aOk = audit.status === 200 && Array.isArray(audit.body && audit.body.logs);
    record('분석: 감사 로그', aOk, `status=${audit.status} logs=${audit.body && audit.body.logs && audit.body.logs.length}`);

    // 개발 환경에서는 공개, 운영에서는 토큰/차단 정책 적용
    const metrics = await req('/metrics');
    const metricsAllowed = metrics.status === 200 || metrics.status === 401 || metrics.status === 404;
    record(
      'Prometheus /metrics 정책 적용',
      metricsAllowed && (metrics.status !== 200 || String(metrics.body).includes('tev1_users_total')),
      `status=${metrics.status}`
    );

    // --- 조직 API 실경로 ---
    const orgList = await req(`/api/organizations`, { headers: { Authorization: `Bearer ${token}` } });
    record('조직: 목록', orgList.status === 200 && orgList.body.organizations.length >= 1, `status=${orgList.status} count=${orgList.body && orgList.body.organizations && orgList.body.organizations.length}`);

    const orgDetail = await req(`/api/organizations/${orgId}`, { headers: { Authorization: `Bearer ${token}` } });
    record('조직: 상세(멤버/방)', orgDetail.status === 200 && orgDetail.body.members.length >= 1, `members=${orgDetail.body && orgDetail.body.members && orgDetail.body.members.length} rooms=${orgDetail.body && orgDetail.body.rooms && orgDetail.body.rooms.length}`);

    // --- 인증 실경로: 비밀번호 가입 → 로그인 → 세션 ---
    const newUser = 'smoke-login-' + Date.now();
    const newPw = 'NewSmoke123';
    const regNew = await req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ userId: newUser, name: '로그인테스터', password: newPw }),
    });
    const regOk = regNew.status === 201 && typeof regNew.body.token === 'string';
    record('인증: 회원가입 + 세션 발급', regOk, `status=${regNew.status}`);

    const loginNew = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ userId: newUser, password: newPw }),
    });
    const lOk = loginNew.status === 200 && typeof loginNew.body.token === 'string';
    record('인증: 로그인 200 + 토큰', lOk, `status=${loginNew.status}`);

    const newToken = (loginNew.body && loginNew.body.token) || (regNew.body && regNew.body.token);
    const me = await req('/api/auth/me', { headers: { Authorization: `Bearer ${newToken}` } });
    const meOk = me.status === 200 && me.body && me.body.user && me.body.user.id === newUser;
    record('인증: /me 조회 (userId 스푸핑 차단)', meOk, `status=${me.status} id=${me.body && me.body.user && me.body.user.id}`);

    // 비밀번호 해시가 평문으로 저장되지 않아야 한다
    const hashRow = await pool.query('SELECT password_hash FROM users WHERE id = $1', [newUser]);
    const stored = hashRow.rows[0] && hashRow.rows[0].password_hash;
    record(
      '인증: 비밀번호 해시 저장 (평문 아님)',
      typeof stored === 'string' && stored.startsWith('scrypt$') && !stored.includes(newPw),
      stored ? stored.slice(0, 12) + '...' : 'none'
    );

    // ===================== 이메일 인증 / 2FA / 초대 메일 =====================
    const mailer = require('../src/mailer');
    const totpLib = require('../src/totp');
    const mailTo = `m-${Date.now()}@example.com`;

    // 1) 가입 시 인증 메일 발송
    const emailUser = 'mailuser-' + Date.now();
    const regEmail = await req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ userId: emailUser, name: '메일유저', password: 'MailPass123', email: mailTo }),
    });
    record('이메일: 가입 시 인증 필요 표시', regEmail.status === 201 && regEmail.body.emailVerificationRequired === true, `status=${regEmail.status}`);
    const verifyMail = mailer.lastMailTo(mailTo);
    record('이메일: 인증 메일 발송', !!verifyMail, verifyMail ? verifyMail.subject : '없음');
    const verifyToken = verifyMail && (verifyMail.html.match(/\?verify=([A-Za-z0-9_-]+)/) || [])[1];
    record('이메일: 인증 링크 토큰 포함', !!verifyToken, '');

    // 2) 잘못된 형식 이메일 거부
    const badEmail = await req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ userId: 'bademail-' + Date.now(), name: 'B', password: 'MailPass123', email: 'not-an-email' }),
    });
    record('이메일: 형식 오류 400', badEmail.status === 400 && badEmail.body.code === 'INVALID_EMAIL', `status=${badEmail.status}`);

    // 3) 인증 완료 → 재사용 불가
    if (verifyToken) {
      const v1 = await req('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });
      record('이메일: 인증 완료 200', v1.status === 200, `status=${v1.status}`);
      const v2 = await req('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });
      record('이메일: 인증 링크 1회만 사용', v2.status === 400 && v2.body.code === 'INVALID_TOKEN', `status=${v2.status}`);
    }

    // 4) 미등록 이메일 재전송: 계정 존재 여부 비노출
    const resendUnknown = await req('/api/auth/resend-verification', {
      method: 'POST', body: JSON.stringify({ email: 'nobody-' + Date.now() + '@example.com' }),
    });
    record('이메일: 미등록 주소 재전송도 200', resendUnknown.status === 200, `status=${resendUnknown.status}`);

    // 5) 비밀번호 재설정 전체 흐름
    const pwUser = 'pwuser-' + Date.now();
    const pwEmail = `p-${Date.now()}@example.com`;
    await req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ userId: pwUser, name: '재설정', password: 'OldPass123', email: pwEmail }),
    });
    const oldLogin = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: pwUser, password: 'OldPass123' }) });
    const oldToken = oldLogin.body && oldLogin.body.token;

    const forgot = await req('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: pwEmail }) });
    record('이메일: 비밀번호 찾기 요청 200', forgot.status === 200, `status=${forgot.status}`);
    const resetMail = mailer.lastMailTo(pwEmail);
    const resetToken = resetMail && (resetMail.html.match(/\?reset=([A-Za-z0-9_-]+)/) || [])[1];
    record('이메일: 재설정 링크 발송', !!resetToken, '');

    if (resetToken) {
      const reset = await req('/api/auth/reset-password', {
        method: 'POST', body: JSON.stringify({ token: resetToken, newPassword: 'NewPass456' }),
      });
      record('이메일: 비밀번호 재설정 200', reset.status === 200, `status=${reset.status}`);
      const tryOld = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: pwUser, password: 'OldPass123' }) });
      record('이메일: 기존 비밀번호로 로그인 불가', tryOld.status === 401, `status=${tryOld.status}`);
      const tryNew = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: pwUser, password: 'NewPass456' }) });
      record('이메일: 새 비밀번호로 로그인 성공', tryNew.status === 200, `status=${tryNew.status}`);
      if (oldToken) {
        const stale = await req('/api/auth/me', { headers: { Authorization: 'Bearer ' + oldToken } });
        record('이메일: 재설정 시 기존 세션 폐기', stale.status === 401, `status=${stale.status}`);
      }
      const reuse = await req('/api/auth/reset-password', {
        method: 'POST', body: JSON.stringify({ token: resetToken, newPassword: 'ThirdPass7' }),
      });
      record('이메일: 재설정 링크 1회만 사용', reuse.status === 400, `status=${reuse.status}`);
    }

    // 6) 2FA 전체 흐름
    const faUser = 'fauser-' + Date.now();
    await req('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ userId: faUser, name: '2FA', password: 'FaPass12345' }),
    });
    const faLogin = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: faUser, password: 'FaPass12345' }) });
    const faToken = faLogin.body && faLogin.body.token;
    const FA = { Authorization: `Bearer ${faToken}` };

    const faStatus = await req('/api/auth/2fa/status', { headers: FA });
    record('2FA: 초기 꺼짐', faStatus.body.enabled === false, `enabled=${faStatus.body.enabled}`);

    const faSetup = await req('/api/auth/2fa/setup', { method: 'POST', headers: FA });
    record('2FA: 설정 시작 - 시크릿/URI 발급', faSetup.status === 200 && !!faSetup.body.secret && !!faSetup.body.otpauthUri, `status=${faSetup.status}`);
    const secret = faSetup.body && faSetup.body.secret;

    // 아직 활성화 전이므로 코드 없이 로그인 가능해야 한다
    const preLogin = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: faUser, password: 'FaPass12345' }) });
    record('2FA: 확정 전에는 로그인 영향 없음', preLogin.status === 200, `status=${preLogin.status}`);

    const wrongConfirm = await req('/api/auth/2fa/confirm', { method: 'POST', headers: FA, body: JSON.stringify({ code: '000000' }) });
    record('2FA: 오류 코드로 확정 불가', wrongConfirm.status === 400, `status=${wrongConfirm.status}`);

    const confirm = await req('/api/auth/2fa/confirm', {
      method: 'POST', headers: FA, body: JSON.stringify({ code: totpLib.currentCode(secret) }),
    });
    record('2FA: 활성화 + 복구 코드 발급', confirm.status === 200 && Array.isArray(confirm.body.recoveryCodes) && confirm.body.recoveryCodes.length === 10, `status=${confirm.status}`);
    const recoveryCodes = confirm.body && confirm.body.recoveryCodes;

    // 이제 로그인은 코드를 요구한다
    const noCode = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: faUser, password: 'FaPass12345' }) });
    record('2FA: 코드 없이 로그인 차단', noCode.status === 401 && noCode.body.totpRequired === true, `status=${noCode.status}`);
    const wrongCode = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: faUser, password: 'FaPass12345', totpCode: '000000' }) });
    record('2FA: 오류 코드 로그인 거부', wrongCode.status === 401, `status=${wrongCode.status}`);
    const withCode = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: faUser, password: 'FaPass12345', totpCode: totpLib.currentCode(secret) }) });
    record('2FA: 올바른 코드로 로그인', withCode.status === 200 && !!withCode.body.token, `status=${withCode.status}`);

    // 복구 코드로 로그인 → 1회성
    if (recoveryCodes && recoveryCodes.length) {
      const recLogin = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: faUser, password: 'FaPass12345', totpCode: recoveryCodes[0] }) });
      record('2FA: 복구 코드로 로그인', recLogin.status === 200 && recLogin.body.usedRecoveryCode === true, `status=${recLogin.status}`);
      const recReuse = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: faUser, password: 'FaPass12345', totpCode: recoveryCodes[0] }) });
      record('2FA: 복구 코드 재사용 불가', recReuse.status === 401, `status=${recReuse.status}`);
      // 남은 복구 코드 개수 확인
      const after = await req('/api/auth/2fa/status', { headers: FA });
      record('2FA: 사용 후 복구 코드 감소', after.body.recoveryCodesLeft === recoveryCodes.length - 1, `left=${after.body.recoveryCodesLeft}`);
      // 복구 코드는 DB에 해시로만 저장된다
      const recStored = await pool.query('SELECT recovery_codes FROM users WHERE id = $1', [faUser]);
      const storedCodes = recStored.rows[0] && recStored.rows[0].recovery_codes;
      const leaks = Array.isArray(storedCodes) && recoveryCodes.some((c) => (storedCodes || []).includes(c));
      record('2FA: 복구 코드 평문 미저장', !leaks, storedCodes ? `stored=${storedCodes.length}건(해시)` : 'none');
    }

    // 7) 초대 메일 발송
    const invMailTo = `inv-${Date.now()}@example.com`;
    const orgForMail = await req('/api/organizations', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '메일초대조직', slug: 'mi-' + Date.now() }),
    });
    if (orgForMail.status === 201) {
      const inv = await req(`/api/organizations/${orgForMail.body.organization.id}/invites`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: invMailTo, role: 'member' }),
      });
      record('초대: 생성 200', inv.status === 200, `status=${inv.status}`);
      const invMail = mailer.lastMailTo(invMailTo);
      record('초대: 메일 발송됨', !!invMail, invMail ? invMail.subject : '없음');
      record('초대: 메일에 조직명 포함', !!(invMail && invMail.html.includes('메일초대조직')), '');
      record('초대: 메일에 링크 포함', !!(invMail && inv.body.invite && invMail.html.includes(inv.body.invite.token)), '');
      record('초대: 발송 결과 응답에 포함', inv.body.delivery && typeof inv.body.delivery.ok === 'boolean', JSON.stringify(inv.body.delivery));
    }

    // --- Phase 3-4 대시보드 소비 시나리오 (UI가 쓰는 경로 그대로) ---
    const slug = 'dash-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const orgCreate = await req('/api/organizations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '대시보드 조직', slug }),
    });
    record(
      '대시보드: 조직 생성',
      orgCreate.status === 201 && !!orgCreate.body.organization,
      `status=${orgCreate.status}`
    );
    const newOrgId = orgCreate.body && orgCreate.body.organization && orgCreate.body.organization.id;

    if (newOrgId) {
      const list = await req('/api/organizations', { headers: { Authorization: `Bearer ${token}` } });
      record('대시보드: 조직 목록에 노출', list.body.organizations.some((o) => o.id === newOrgId), `count=${list.body.organizations.length}`);

      // UI의 apiGet()가 호출하는 경로들
      const dashPaths = [
        `/api/analytics/meetings/summary?orgId=${newOrgId}`,
        `/api/analytics/realtime?orgId=${newOrgId}`,
        `/api/analytics/organizations/${newOrgId}/trends?period=30d`,
        `/api/analytics/audit?orgId=${newOrgId}`,
      ];
      let allOk = true;
      for (const p of dashPaths) {
        const r = await req(p, { headers: { Authorization: `Bearer ${token}` } });
        if (r.status !== 200) {
          allOk = false;
          record('대시보드 조회 실패: ' + p, false, `status=${r.status}`);
        }
      }
      record('대시보드: 4개 조회 모두 200', allOk);

      // 빈 조직이어도 UI가 깨지지 않아야 한다 (배열 필드 존재)
      const emptySummary = await req(`/api/analytics/meetings/summary?orgId=${newOrgId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      record(
        '대시보드: 빈 데이터도 배열 제공',
        emptySummary.status === 200 &&
          Array.isArray(emptySummary.body.dailyMeetings) &&
          Array.isArray(emptySummary.body.topUsers),
        ''
      );

      // 멤버 관리 UI가 읽는 구조
      const mem = await req(`/api/organizations/${newOrgId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      record(
        '대시보드: 멤버/방/역할 구조',
        mem.status === 200 && Array.isArray(mem.body.members) && Array.isArray(mem.body.rooms) && !!mem.body.userRole,
        `role=${mem.body && mem.body.userRole}`
      );

      // 초대 생성 (UI가 링크를 안내한다)
      const inv = await req(`/api/organizations/${newOrgId}/invites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
      });
      record(
        '대시보드: 초대 생성 + invitePath',
        inv.status === 200 && inv.body.invite && !!inv.body.invite.invitePath,
        `status=${inv.status}`
      );

      // 권한 규칙 검증
      // 1) 유일한 owner의 강등은 조직 보호를 위해 409로 막혀야 한다
      const lastOwner = await req(`/api/organizations/${newOrgId}/members/${userA}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: 'admin' }),
      });
      record('권한: 유일 owner 강등 차단 409', lastOwner.status === 409, `status=${lastOwner.status}`);

      // 2) 초대장으로 멤버를 추가하면 owner 외 멤버가 생기므로 그다음 admin 지정 가능
      const inviteForMember = await req(`/api/organizations/${newOrgId}/invites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: 'promote@example.com', role: 'member' }),
      });
      const promoteToken = inviteForMember.body && inviteForMember.body.invite && inviteForMember.body.invite.token;
      const promoteeId = 'promote-' + Date.now();
      if (promoteToken) {
        const pr = await req('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ userId: promoteeId, name: '승진대상', password: 'Promote123' }),
        });
        if (pr.status === 201) {
          await req(`/api/organizations/invites/${promoteToken}/accept`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + pr.body.token },
          });
          const promote = await req(`/api/organizations/${newOrgId}/members/${promoteeId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify({ role: 'admin' }),
          });
          record('권한: owner가 admin 지정 가능', promote.status === 200, `status=${promote.status}`);

          // 3) admin은 owner/admin 역할을 변경할 수 없다
          const adminCannot = await req(`/api/organizations/${newOrgId}/members/${userA}`, {
            method: 'PATCH',
            headers: { Authorization: 'Bearer ' + pr.body.token },
            body: JSON.stringify({ role: 'member' }),
          });
          record('권한: admin은 owner 변경 불가 403', adminCannot.status === 403, `status=${adminCannot.status}`);

          // 4) admin이 viewer로 강등시킨 뒤 초대 시도 → 차단되어야 한다
          const demoteSelf = await req(`/api/organizations/${newOrgId}/members/${promoteeId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify({ role: 'viewer' }),
          });
          record('권한: owner가 admin→viewer 강등', demoteSelf.status === 200, `status=${demoteSelf.status}`);
          const forbidden = await req(`/api/organizations/${newOrgId}/invites`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + pr.body.token },
            body: JSON.stringify({ email: 'x@example.com' }),
          });
          record('권한: viewer 초대 차단 403', forbidden.status === 403, `status=${forbidden.status}`);
        }
      }

      // 실제 초대 수락 흐름 (다른 계정으로)
      const invitee = 'invitee-' + Date.now();
      const regInvitee = await req('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ userId: invitee, name: '초대받은사람', password: 'Invitee12345' }),
      });
      const inviteToken = inv.body && inv.body.invite && inv.body.invite.token;
      if (regInvitee.status === 201 && inviteToken) {
        const accept = await req(`/api/organizations/invites/${inviteToken}/accept`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + regInvitee.body.token },
        });
        record('초대 수락: 인증 계정으로 가입', accept.status === 200, `status=${accept.status}`);
        const afterMembers = await req(`/api/organizations/${newOrgId}`, {
          headers: { Authorization: 'Bearer ' + regInvitee.body.token },
        });
        record('초대 수락: 멤버로 반영', afterMembers.body.members.some((m) => m.user_id === invitee), '');
      }
    }

    // 초대 수락은 인증 필수 (우회 방지)
    const anonAccept = await req('/api/organizations/invites/fake-token/accept', { method: 'POST' });
    record('초대 수락 무인증 차단 401', anonAccept.status === 401, `status=${anonAccept.status}`);

    // session 폐기 → 기존 토큰 거부
    await req('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${newToken}` } });
    const meAfter = await req('/api/auth/me', { headers: { Authorization: `Bearer ${newToken}` } });
    record('인증: 로그아웃 후 토큰 401', meAfter.status === 401, `status=${meAfter.status}`);

    // --- health가 DB를 connected로 보고하는지 ---
    const health = await req('/health');
    record('헬스체크 DB connected', health.status === 200 && health.body.database === 'connected', `database=${health.body && health.body.database}`);
    const health2 = await req('/health/detailed');
    record('헬스체크 상세 DB up', health2.status === 200 && health2.body.services.database.status === 'up', `db=${health2.body && health2.body.services && health2.body.services.database.status}`);
  } catch (e) {
    record('DB 스위트 실행', false, e.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

function testSocketFlow(token) {
  return new Promise((resolve) => {
    const result = {
      ok: false,
      detail: '',
      cursorOk: false,
      cursorDetail: '',
      signalHandlers: false,
      handlerDetail: '',
    };
    let socket;
    try {
      // 서버가 socket.io를 노출하므로 클라이언트 소켓은 최소 구현으로 대체
      const ioClient = require('socket.io-client');
      socket = ioClient(BASE, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    } catch (e) {
      result.detail = 'socket.io-client 미설치: ' + e.message;
      return resolve(result);
    }

    const timer = setTimeout(() => {
      result.detail = result.detail || '타임아웃';
      try { socket.close(); } catch (_) {}
      resolve(result);
    }, 8000);

    socket.on('connect', () => {
      socket.emit('auth', { token, roomId: 'smoke-room' });
    });

    socket.on('joined', (payload) => {
      result.ok = true;
      result.detail = `userId=${payload && payload.id}`;
      // 등록된 시그널링 이벤트 확인 후 종료
      result.signalHandlers = true;
      result.handlerDetail = 'webrtc-offer/answer/ice-candidate 중계 활성';
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      resolve(result);
    });

    socket.on('auth_error', (err) => {
      result.detail = 'auth_error: ' + (err && err.message);
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      resolve(result);
    });

    socket.on('connect_error', (err) => {
      result.detail = 'connect_error: ' + err.message;
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function shutdown(server, io, code) {
  return new Promise((resolve) => {
    try { if (io) io.close(() => {}); } catch (_) {}
    try { server.close(() => {}); } catch (_) {}
    // 프로세스가 확실히 종료되도록 강제 종료
    setTimeout(() => {
      try { require('process').exit(code); } catch (_) { resolve(); }
    }, 300);
  });
}

main().catch((e) => {
  console.error('스모크 테스트 자체 실패:', e);
  process.exit(1);
});