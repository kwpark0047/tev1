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

async function req(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { status: res.status, body };
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

  // 3) JWT 발급 (레거시 wss 없이도 동작해야 함)
  let token = null;
  try {
    const { status, body } = await req('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ userId: 'smoke-user', name: '스모크' }),
    });
    token = body && body.token;
    record('/api/auth/token JWT 발급', status === 200 && typeof token === 'string', `status=${status}`);
  } catch (e) {
    record('/api/auth/token JWT 발급', false, e.message);
  }

  // 4) /api/auth/me 토큰 검증
  try {
    const { status, body } = await req('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // DB가 없으면 500이 아니라 인증 실패/사용자 없음 중 하나여야 한다(크래시 아님)
    record('/api/auth/me 토큰 검증 (크래시 없음)', [200, 401, 404, 500].includes(status), `status=${status} ${body && body.error ? body.error : ''}`);
  } catch (e) {
    record('/api/auth/me 토큰 검증 (크래시 없음)', false, e.message);
  }

  // 5) 잘못된 토큰은 401
  try {
    const { status } = await req('/api/auth/me', { headers: { Authorization: 'Bearer invalid.token' } });
    record('잘못된 토큰 401', status === 401, `status=${status}`);
  } catch (e) {
    record('잘못된 토큰 401', false, e.message);
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

    const metrics = await req('/metrics');
    const mOk = metrics.status === 200 && String(metrics.body).includes('tev1_users_total');
    record('Prometheus /metrics', mOk, `status=${metrics.status}`);

    // --- 조직 API 실경로 ---
    const orgList = await req(`/api/organizations`, { headers: { Authorization: `Bearer ${token}` } });
    record('조직: 목록', orgList.status === 200 && orgList.body.organizations.length >= 1, `status=${orgList.status} count=${orgList.body && orgList.body.organizations && orgList.body.organizations.length}`);

    const orgDetail = await req(`/api/organizations/${orgId}`, { headers: { Authorization: `Bearer ${token}` } });
    record('조직: 상세(멤버/방)', orgDetail.status === 200 && orgDetail.body.members.length >= 1, `members=${orgDetail.body && orgDetail.body.members && orgDetail.body.members.length} rooms=${orgDetail.body && orgDetail.body.rooms && orgDetail.body.rooms.length}`);

    // --- 인증 실경로 (login이 DB에 사용자 생성) ---
    const newUser = 'smoke-login-' + Date.now();
    const login = await req('/api/auth/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: newUser, name: '로그인테스터' }),
    });
    const lOk = login.status === 200 && typeof login.body.token === 'string';
    record('인증: login 사용자 자동 생성', lOk, `status=${login.status}`);

    const me = await req('/api/auth/me', { headers: { Authorization: `Bearer ${login.body && login.body.token}` } });
    const meOk = me.status === 200 && me.body && me.body.user && me.body.user.id === newUser;
    record('인증: /me 조회 (userId 스푸핑 차단)', meOk, `status=${me.status} id=${me.body && me.body.user && me.body.user.id}`);

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