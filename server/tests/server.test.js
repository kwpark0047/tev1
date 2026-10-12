#!/usr/bin/env node
// server/tests/server.test.js — Socket.IO 서버 핸들러 검증 테스트
// standalone: node tests/server.test.js → PASS/FAIL 카운터 출력
// 의존: socket.io-client (devDep), jsonwebtoken, assert

'use strict';

const { io, app, server } = require('../src/server');
const jwt = require('jsonwebtoken');
const assert = require('assert');

const TEST_PORT = 8081; // 서버가 기본적으로 사용하는 포트

// ---------------------------------------------------------------------------
// 테스트 카운터 및 유틸리티
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`       ${e.message}`);
  }
}

// 서버 모듈 로드 검증
test('서버 인스턴스 로드', () => {
  assert.ok(typeof io === 'object', 'io must be an object');
  assert.ok(typeof io.of === 'function', 'io.of must be a function (Socket.IO namespace)');
});

// socket.io-client로 연결 테스트 헬퍼
function createSocket(url = `http://localhost:${TEST_PORT}`) {
  const sio = require('socket.io-client');
  return sio.connect(url, { transports: ['websocket'] });
}

// ---------------------------------------------------------------------------
// 테스트 케이스
// ---------------------------------------------------------------------------

test('정상 연결', (done) => {
  const socket = createSocket();
  let connected = false;

  socket.on('connect', () => {
    connected = true;
    socket.disconnect();
  });

  socket.on('disconnect', () => {
    if (connected) {
      done();
    } else {
      done(new Error('연결되지 않음'));
    }
  });
});

test('인증: 유효한 JWT 토큰', (done) => {
  const socket = createSocket();

  socket.on('connect', () => {
    const token = jwt.sign({ userId: 'test-user', name: 'Test User' }, 'test-secret');
    socket.emit('auth', { token });
  });

  socket.on('auth_result', (msg) => {
    try {
      assert.strictEqual(msg.success, true, 'auth_result success must be true');
      assert.strictEqual(msg.userId, 'test-user', 'userId must match');
      assert.strictEqual(msg.name, 'Test User', 'name must match');
      socket.disconnect();
      done();
    } catch (e) {
      socket.disconnect();
      done(e);
    }
  });

  socket.on('connect_error', (err) => {
    socket.disconnect();
    done(err);
  });
});

test('인증: 유효하지 않은 토큰', (done) => {
  const socket = createSocket();

  socket.on('connect', () => {
    socket.emit('auth', { token: 'invalid-token' });
  });

  socket.on('auth_error', (msg) => {
    try {
      assert.strictEqual(msg.message, '유효하지 않은 세션입니다.', 'auth_error message must match');
      socket.disconnect();
      done();
    } catch (e) {
      socket.disconnect();
      done(e);
    }
  });

  socket.on('connect_error', (err) => {
    socket.disconnect();
    done(err);
  });
});

test('인증: 세션 종료된 경우', (done) => {
  const socket = createSocket();

  socket.on('connect', () => {
    socket.emit('auth', { token: 'expired-or-revoked' });
  });

  socket.on('auth_error', (msg) => {
    try {
      assert.strictEqual(msg.code, 'SESSION_REVOKED', 'code must be SESSION_REVOKED');
      socket.disconnect();
      done();
    } catch (e) {
      socket.disconnect();
      done(e);
    }
  });

  socket.on('connect_error', (err) => {
    socket.disconnect();
    done(err);
  });
});

test('방 입장', (done) => {
  const socket = createSocket();

  socket.on('connect', () => {
    const token = jwt.sign({ userId: 'test-user', name: 'Test User' }, 'test-secret');
    socket.emit('auth', { token });
  });

  socket.on('auth_result', () => {
    socket.emit('join', { roomId: 'test-room', name: 'Test User' });
  });

  socket.on('joined', (msg) => {
    try {
      assert.strictEqual(msg.userId, 'test-user', 'userId must match');
      assert.strictEqual(msg.name, 'Test User', 'name must match');
      assert.strictEqual(msg.users.length, 1, 'users must have length 1');
      socket.disconnect();
      done();
    } catch (e) {
      socket.disconnect();
      done(e);
    }
  });

  socket.on('connect_error', (err) => {
    socket.disconnect();
    done(err);
  });
});

test('다른 사용자에게 커서 broadcast', (done) => {
  const socket1 = createSocket();
  const socket2 = createSocket();

  let socket1Connected = false;
  let socket2Connected = false;

  socket1.on('connect', () => {
    socket1Connected = true;
    if (socket1Connected && socket2Connected) {
      socket1.emit('cursor', { x: 100, y: 200 });
    }
  });

  socket2.on('connect', () => {
    socket2Connected = true;
    if (socket1Connected && socket2Connected) {
      socket2.disconnect();
      socket1.disconnect();
      done();
    }
  });

  socket2.on('cursor', (msg) => {
    try {
      assert.strictEqual(msg.x, 100, 'x must be 100');
      assert.strictEqual(msg.y, 200, 'y must be 200');
      assert.strictEqual(msg.userId, 'test-user', 'userId must match');
      socket2.disconnect();
      socket1.disconnect();
      done();
    } catch (e) {
      socket2.disconnect();
      socket1.disconnect();
      done(e);
    }
  });
});

// ---------------------------------------------------------------------------
// 종료 보고
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);