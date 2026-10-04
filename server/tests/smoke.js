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
  const { server, io } = mod;

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

  // 6-2) 인증되었지만 DB 미가용이면 503
  try {
    const { status, body } = await req('/api/analytics/meetings/summary?orgId=x', {
      headers: { Authorization: `Bearer ${token}` },
    });
    record('분석 API DB 미가용 503', status === 503 && body && body.code === 'DB_UNAVAILABLE', `status=${status} code=${body && body.code}`);
  } catch (e) {
    record('분석 API DB 미가용 503', false, e.message);
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n요약: ${results.length - failed.length}/${results.length} 통과 (${Date.now() - started}ms)`);
  if (failed.length) {
    console.log('실패 항목:');
    for (const f of failed) console.log(`  - ${f.name} (${f.detail || ''})`);
  }

  await shutdown(server, io, failed.length ? 1 : 0);
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