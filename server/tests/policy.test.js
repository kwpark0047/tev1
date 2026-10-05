#!/usr/bin/env node
/**
 * 계정 정책 테스트
 * - 이메일 인증 강제(REQUIRE_EMAIL_VERIFICATION=true)
 * - 레거시 계정(비밀번호 미설정) 초기화 플로우
 * - 비밀번호 변경 시 세션 무효화 + 세션 관리 API
 *
 * 정책은 서버 기동 시점의 환경변수로 결정되므로 별도 프로세스에서 검증한다.
 * 사용법: node tests/policy.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

// 정책 강제를 켠 상태로 기동한다 (NODE_ENV=production도 함께 검증)
process.env.REQUIRE_EMAIL_VERIFICATION = 'true';

const PORT = Number(process.env.TEV1_POLICY_PORT || 8096);
const TIMEOUT_MS = Number(process.env.TEV1_SMOKE_TIMEOUT_MS || 60000);
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'production';

delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
if (!process.env.MAIL_OUTBOX_FILE) process.env.MAIL_OUTBOX_FILE = '/tmp/tev1-policy-outbox.jsonl';

const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://tev1@127.0.0.1:5432/tev1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const SKIP_DB = process.env.TEV1_SKIP_DB === '1';
process.env.DATABASE_URL = DATABASE_URL;
process.env.REDIS_URL = REDIS_URL;

let ipCounter = 0;
function nextTestIp() {
  ipCounter += 1;
  return `10.88.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
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
  const mod = require(path.join(__dirname, '..', 'src', 'server.js'));
  const { pool, ready } = mod;

  const up = await waitForReady(30000);
  if (!up) {
    record('서버 기동', false, 'health 응답 없음');
    return finish(null, null);
  }
  await ready;
  record('서버 기동', true);

  const mailer = require('../src/mailer');

  // ---------- 1) 이메일 인증 강제 ----------
  const noEmail = 'noemail-' + Date.now();
  const r1 = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ userId: noEmail, name: '이메일없음', password: 'Passw0rd123' }),
  });
  record('정책: 이메일 없이 가입 불가', r1.status === 400 && r1.body.code === 'EMAIL_REQUIRED', `status=${r1.status} code=${r1.body.code}`);

  const badEmail = 'bademail2-' + Date.now();
  const r2 = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ userId: badEmail, name: '형식오류', password: 'Passw0rd123', email: 'nope' }),
  });
  record('정책: 이메일 형식 오류 거부', r2.status === 400 && r2.body.code === 'INVALID_EMAIL', `status=${r2.status}`);

  // 미인증 상태에서 로그인 시도 → 차단되어야 한다
  const mailUser = 'policy-' + Date.now();
  const mailTo = `pol-${Date.now()}@example.com`;
  const r3 = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ userId: mailUser, name: '정책테스트', password: 'Passw0rd123', email: mailTo }),
  });
  record('정책: 이메일 가입 성공', r3.status === 201 && r3.body.emailVerificationRequired === true, `status=${r3.status}`);

  const unverifiedLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: mailUser, password: 'Passw0rd123' }),
  });
  record(
    '정책: 미인증 계정 로그인 차단',
    unverifiedLogin.status === 403 && unverifiedLogin.body.code === 'EMAIL_NOT_VERIFIED',
    `status=${unverifiedLogin.status} code=${unverifiedLogin.body.code}`
  );

  // 인증 메일 발송 확인 후 인증 처리 → 로그인 허용
  const vmail = mailer.lastMailTo(mailTo);
  const vtoken = vmail && (vmail.html.match(/\?verify=([A-Za-z0-9_-]+)/) || [])[1];
  record('정책: 인증 메일 발송', !!vtoken, '');

  if (vtoken) {
    const v = await req('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: vtoken }) });
    record('정책: 인증 완료', v.status === 200, `status=${v.status}`);

    const okLogin = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ userId: mailUser, password: 'Passw0rd123' }),
    });
    record('정책: 인증 후 로그인 허용', okLogin.status === 200 && okLogin.body.emailVerified === true, `status=${okLogin.status}`);

    // ---------- 2) 레거시 계정 초기화 ----------
    // password_hash가 비어 있는 계정을 직접 만든다 (레거시 데이터 재현)
    const legacyId = 'legacy-' + Date.now();
    const legacyEmail = `leg-${Date.now()}@example.com`;
    await pool.query(
      'INSERT INTO users (id, name, color, is_active, email, password_hash) VALUES ($1, $2, $3, true, $4, NULL)',
      [legacyId, '레거시', '#888888', legacyEmail]
    );

    const legacyLogin = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ userId: legacyId, password: '아무거나12345' }),
    });
    record(
      '레거시: 비밀번호 미설정 계정 로그인 불가',
      legacyLogin.status === 403 && legacyLogin.body.code === 'PASSWORD_SETUP_REQUIRED',
      `status=${legacyLogin.status} code=${legacyLogin.body.code}`
    );
    record('레거시: 이메일 보유 안내', legacyLogin.body.email === true, `email=${legacyLogin.body.email}`);

    // 이메일 불일치 → 아무 것도 하지 않는다 (계정 존재 비노출)
    const wrongMail = await req('/api/auth/setup-password', {
      method: 'POST',
      body: JSON.stringify({ userId: legacyId, email: 'wrong@example.com' }),
    });
    const wrongText = JSON.stringify(wrongMail.body);
    record('레거시: 이메일 불일치 시 정보 미노출', wrongMail.status === 200 && !wrongText.includes('legacy'), wrongText.slice(0, 80));

    // 정상 요청 → 링크 발송
    const setupReq = await req('/api/auth/setup-password', {
      method: 'POST',
      body: JSON.stringify({ userId: legacyId, email: legacyEmail }),
    });
    record('레거시: 초기화 링크 요청 200', setupReq.status === 200 && setupReq.body.success === true, `status=${setupReq.status}`);
    const smail = mailer.lastMailTo(legacyEmail);
    const stoken = smail && (smail.html.match(/\?setup=([A-Za-z0-9_-]+)/) || [])[1];
    record('레거시: 초기화 링크 발송', !!stoken, '');

    // 이미 비밀번호가 있는 계정은 덮어쓰기 불가
    const notLegacy = await req('/api/auth/setup-password', {
      method: 'POST',
      body: JSON.stringify({ userId: mailUser, email: mailTo }),
    });
    record('레거시: 정상 계정은 초기화 대상 아님', notLegacy.status === 200, `status=${notLegacy.status}`);
    const noSetupMail = mailer.lastMailTo(mailTo) && mailer.lastMailTo(mailTo).subject.includes('비밀번호 설정');
    record('레거시: 정상 계정에는 설정 메일 미발송', !noSetupMail, '');

    if (stoken) {
      const done = await req('/api/auth/complete-setup', {
        method: 'POST',
        body: JSON.stringify({ token: stoken, newPassword: 'LegacyPass123' }),
      });
      record('레거시: 비밀번호 설정 완료', done.status === 200 && done.body.success === true, `status=${done.status}`);

      const legacyNow = await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ userId: legacyId, password: 'LegacyPass123' }),
      });
      record('레거시: 설정 후 로그인 성공', legacyNow.status === 200, `status=${legacyNow.status}`);

      const tokenReuse = await req('/api/auth/complete-setup', {
        method: 'POST',
        body: JSON.stringify({ token: stoken, newPassword: 'AnotherPass1' }),
      });
      record('레거시: 초기화 링크 1회만 사용', tokenReuse.status === 400, `status=${tokenReuse.status}`);

      // 초기화 시점에 이메일 인증도 완료 처리된다
      const verified = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [legacyId]);
      record('레거시: 초기화 시 이메일 인증 완료', !!verified.rows[0].email_verified_at, '');

      // ---------- 3) 비밀번호 변경 + 세션 관리 ----------
      const s1 = await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ userId: legacyId, password: 'LegacyPass123' }),
      });
      const tokA = s1.body.token;

      // 두 번째 세션(다른 기기) 생성
      const s2 = await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ userId: legacyId, password: 'LegacyPass123' }),
      });
      const tokB = s2.body.token;

      const list1 = await req('/api/auth/sessions', { headers: { Authorization: `Bearer ${tokA}` } });
      record('세션: 목록 조회', list1.status === 200 && Array.isArray(list1.body.sessions) && list1.body.sessions.length >= 2, `count=${list1.body.sessions && list1.body.sessions.length}`);
      const currentMarked = (list1.body.sessions || []).filter((x) => x.current).length;
      record('세션: 현재 세션 표시', currentMarked === 1, `current=${currentMarked}`);
      const activeCount = (list1.body.sessions || []).filter((x) => x.active).length;
      record('세션: 활성 상태 표시', activeCount >= 2, `active=${activeCount}`);

      // 다른 기기 세션만 종료
      const revokeOthers = await req('/api/auth/sessions/revoke-others', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokA}` },
      });
      record('세션: 다른 기기 일괄 종료', revokeOthers.status === 200 && revokeOthers.body.revoked >= 1, `revoked=${revokeOthers.body.revoked}`);

      const aAlive = await req('/api/auth/me', { headers: { Authorization: `Bearer ${tokA}` } });
      const bDead = await req('/api/auth/me', { headers: { Authorization: `Bearer ${tokB}` } });
      record('세션: 현재 기기는 유지', aAlive.status === 200, `status=${aAlive.status}`);
      record('세션: 종료된 기기는 401', bDead.status === 401, `status=${bDead.status}`);

      // 비밀번호 변경 → 기본은 전체 세션 폐기
      const change1 = await req('/api/auth/change-password', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokA}` },
        body: JSON.stringify({ currentPassword: 'LegacyPass123', newPassword: 'ChangedPass456' }),
      });
      record('변경: 비밀번호 변경 성공', change1.status === 200 && change1.body.revokedAllSessions === true, `status=${change1.status}`);

      const afterChange = await req('/api/auth/me', { headers: { Authorization: `Bearer ${tokA}` } });
      record('변경: 전체 세션 폐기됨(재로그인 필요)', afterChange.status === 401, `status=${afterChange.status}`);

      // 재로그인 후 현재 세션만 유지 옵션
      const s3 = await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ userId: legacyId, password: 'ChangedPass456' }),
      });
      const tokC = s3.body.token;

      // 동일 비밀번호로 변경 시도 (유효 세션에서 검사해야 한다)
      const same = await req('/api/auth/change-password', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokC}` },
        body: JSON.stringify({ currentPassword: 'ChangedPass456', newPassword: 'ChangedPass456' }),
      });
      record('변경: 동일 비밀번호 거부', same.status === 400 && same.body.code === 'PASSWORD_UNCHANGED', `status=${same.status} code=${same.body.code}`);

      // 잘못된 현재 비밀번호 거부
      const wrongCurrent = await req('/api/auth/change-password', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokC}` },
        body: JSON.stringify({ currentPassword: 'WrongPass999', newPassword: 'AnotherOne123' }),
      });
      record('변경: 현재 비밀번호 오류 거부', wrongCurrent.status === 401, `status=${wrongCurrent.status}`);

      // 약한 새 비밀번호 거부
      const weak = await req('/api/auth/change-password', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokC}` },
        body: JSON.stringify({ currentPassword: 'ChangedPass456', newPassword: 'short' }),
      });
      record('변경: 약한 비밀번호 거부', weak.status === 400 && weak.body.code === 'WEAK_PASSWORD', `status=${weak.status}`);
      await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ userId: legacyId, password: 'ChangedPass456' }),
      });

      const change2 = await req('/api/auth/change-password', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokC}` },
        body: JSON.stringify({ currentPassword: 'ChangedPass456', newPassword: 'FinalPass789', revokeOthers: false }),
      });
      record('변경: 현재 세션 유지 옵션', change2.status === 200 && change2.body.revokedAllSessions === false, `status=${change2.status}`);

      const cAlive = await req('/api/auth/me', { headers: { Authorization: `Bearer ${tokC}` } });
      record('변경: 현재 세션 유지됨', cAlive.status === 200, `status=${cAlive.status}`);

      // ---------- 4) 2FA 해제 시 다른 세션 종료 ----------
      const totpLib = require('../src/totp');
      const setup = await req('/api/auth/2fa/setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokC}` },
      });
      const confirm = await req('/api/auth/2fa/confirm', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokC}` },
        body: JSON.stringify({ code: totpLib.currentCode(setup.body.secret) }),
      });
      record('2FA: 활성화', confirm.status === 200, `status=${confirm.status}`);

      const second = await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ userId: legacyId, password: 'FinalPass789', totpCode: totpLib.currentCode(setup.body.secret) }),
      });
      const tokD = second.body.token;

      const disable = await req('/api/auth/2fa/disable', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokC}` },
        body: JSON.stringify({ password: 'FinalPass789', code: totpLib.currentCode(setup.body.secret) }),
      });
      record('2FA: 해제 성공', disable.status === 200, `status=${disable.status}`);

      const dDead = await req('/api/auth/me', { headers: { Authorization: `Bearer ${tokD}` } });
      const cStill = await req('/api/auth/me', { headers: { Authorization: `Bearer ${tokC}` } });
      record('2FA: 해제 시 다른 세션 종료', dDead.status === 401, `status=${dDead.status}`);
      record('2FA: 해제 시 현재 세션 유지', cStill.status === 200, `status=${cStill.status}`);
    }
  }

  finish(mod, pool);
}

function finish(mod, pool) {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n요약: ${results.length - failed}/${results.length} 통과`);
  const cleanup = async () => {
    try { if (pool) await pool.end(); } catch (_) {}
    if (mod && mod.server) mod.server.close();
    process.exit(failed ? 1 : 0);
  };
  cleanup();
}

main().catch((e) => {
  console.error('policy test error:', e);
  process.exit(1);
});