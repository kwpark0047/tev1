#!/usr/bin/env node
/**
 * TOTP(RFC 6238) 단위 테스트
 * 외부 의존성 없이 표준 테스트 벡터로 정확성을 보장한다.
 *
 * 사용법: node tests/totp.test.js
 */
'use strict';

const assert = require('assert');
const totp = require('../src/totp');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
  }
}

// RFC 6238 Appendix B: SHA-1 시크릿은 ASCII "12345678901234567890" (20바이트)
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('Base32 인코딩/디코딩 왕복', () => {
  for (let len = 1; len <= 32; len += 1) {
    const buf = require('crypto').randomBytes(len);
    const encoded = totp.base32Encode(buf);
    const decoded = totp.base32Decode(encoded);
    assert.strictEqual(Buffer.compare(buf, decoded), 0, `len=${len} 왕복 실패`);
  }
});

test('Base32는 A-Z2-7 문자만 사용', () => {
  const encoded = totp.base32Encode(require('crypto').randomBytes(20));
  assert.ok(/^[A-Z2-7]+=*$/.test(encoded), `허용 외 문자 포함: ${encoded}`);
});

test('RFC 6238 테스트 벡터 (SHA-1)', () => {
  // { unix time, RFC 전체 코드, 마지막 6자리 }
  // RFC 6238 Appendix B, Table 1 (SHA-1) 원문값
  const vectors = [
    [59, '94287082', '287082'],
    [1111111109, '07081804', '081804'],
    [1111111111, '14050471', '050471'],
    [1234567890, '89005924', '005924'],
    [2000000000, '69279037', '279037'],
    [20000000000, '65353130', '353130'],
  ];
  for (const [time, , expected] of vectors) {
    const got = totp.generateCode(RFC_SECRET, Math.floor(time / 30));
    assert.strictEqual(got, expected, `time=${time}`);
  }
});

test('생성 코드는 항상 6자리 숫자', () => {
  const secret = totp.generateSecret();
  for (let i = 0; i < 200; i += 1) {
    assert.ok(/^\d{6}$/.test(totp.generateCode(secret, i)), `i=${i}`);
  }
});

test('시크릿 생성은 기본 32자 Base32', () => {
  assert.strictEqual(totp.generateSecret().length, 32);
  assert.strictEqual(totp.generateSecret(10).length, 16);
});

test('현재 코드는 검증을 통과', () => {
  const secret = totp.generateSecret();
  assert.strictEqual(totp.verifyCode(secret, totp.currentCode(secret)), true);
});

test('이전/다음 시간창(±1) 코드는 허용', () => {
  const secret = totp.generateSecret();
  const counter = Math.floor(Date.now() / 1000 / 30);
  assert.strictEqual(totp.verifyCode(secret, totp.generateCode(secret, counter - 1)), true);
  assert.strictEqual(totp.verifyCode(secret, totp.generateCode(secret, counter + 1)), true);
});

test('범위 밖(±5) 코드는 거부', () => {
  const secret = totp.generateSecret();
  const counter = Math.floor(Date.now() / 1000 / 30);
  assert.strictEqual(totp.verifyCode(secret, totp.generateCode(secret, counter - 5)), false);
  assert.strictEqual(totp.verifyCode(secret, totp.generateCode(secret, counter + 5)), false);
});

test('형식이 잘못된 입력은 거부(예외 없음)', () => {
  const secret = totp.generateSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '  ']) {
    assert.strictEqual(totp.verifyCode(secret, bad), false, `입력=${bad}`);
  }
});

test('다른 시크릿의 코드는 거부', () => {
  const a = totp.generateSecret();
  const b = totp.generateSecret();
  assert.strictEqual(totp.verifyCode(b, totp.currentCode(a)), false);
});

test('음수 카운터는 예외 없이 처리', () => {
  const secret = totp.generateSecret();
  assert.strictEqual(typeof totp.generateCode(secret, -1), 'string');
  assert.strictEqual(totp.verifyCode(secret, '000000', { atMs: -100000 }), false);
});

test('otpauth URI가 표준 형식', () => {
  const uri = totp.otpauthUri({ secret: 'ABC', account: 'u@e.com', issuer: 'TEV1' });
  assert.ok(uri.startsWith('otpauth://totp/'), uri);
  assert.ok(uri.includes('secret=ABC'), uri);
  assert.ok(uri.includes('issuer=TEV1'), uri);
  assert.ok(uri.includes('algorithm=SHA1'), uri);
  assert.ok(uri.includes('digits=6'), uri);
  assert.ok(uri.includes('period=30'), uri);
});

test('복구 코드 형식과 개수', () => {
  const codes = totp.generateRecoveryCodes();
  assert.strictEqual(codes.length, totp.RECOVERY_CODE_COUNT);
  for (const c of codes) {
    assert.ok(totp.isValidRecoveryCodeFormat(c), `형식 오류: ${c}`);
  }
  // 중복이 없어야 한다
  assert.strictEqual(new Set(codes).size, codes.length);
});

test('복구 코드는 1회만 사용 가능', () => {
  const codes = totp.generateRecoveryCodes();
  const first = totp.consumeRecoveryCode(codes, codes[0]);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.remaining.length, codes.length - 1);
  // 같은 코드로 다시 시도하면 실패
  assert.strictEqual(totp.consumeRecoveryCode(first.remaining, codes[0]).ok, false);
});

test('복구 코드 정규화(하이픈/대소문자 무시)', () => {
  const codes = ['ABCD-1234'];
  assert.strictEqual(totp.consumeRecoveryCode(codes, 'abcd1234').ok, true);
  assert.strictEqual(totp.consumeRecoveryCode(codes, 'ABCD-1234').ok, true);
  assert.strictEqual(totp.consumeRecoveryCode(codes, 'wxyz-9999').ok, false);
});

console.log(`\n요약: ${passed}/${passed + failed} 통과`);
process.exit(failed ? 1 : 0);