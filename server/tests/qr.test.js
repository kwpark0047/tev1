#!/usr/bin/env node
/**
 * 2FA QR 코드 스캔 검증
 *
 * 서버가 생성한 otpauth:// URI가 실제 인증앱(스캐너)으로 읽히는지 검증한다.
 * - qrcode → PNG 렌더링
 * - jsQR로 실제 디코딩
 * - 디코딩된 URI에서 꺼낸 시크릿으로 TOTP 코드를 생성해 totp.js와 대조
 *
 * jsQR/pngjs는 검증 전용이므로 devDependencies에 둔다.
 * 사용법: node tests/qr.test.js
 */
'use strict';

const assert = require('assert');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const totp = require('../src/totp');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
  }
}

/** QR을 PNG로 렌더링 후 실제 디코딩해 원문을 복원한다 */
async function scanQr(uri, width = 400) {
  const buf = await QRCode.toBuffer(uri, { type: 'png', width, margin: 4, errorCorrectionLevel: 'M' });
  const png = PNG.sync.read(buf);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return decoded ? decoded.data : null;
}

async function main() {
  const secret = totp.generateSecret();
  const uri = totp.otpauthUri({ secret, account: 'testuser', issuer: 'TEV1' });

  await test('QR: otpauth URI가 실제 스캔으로 복원됨', async () => {
    const data = await scanQr(uri);
    assert.ok(data, 'QR 디코딩 실패');
    assert.strictEqual(data, uri, '복원된 URI가 원본과 다름');
  });

  await test('QR: 스캔 결과에서 시크릿이 정확히 복원됨', async () => {
    const data = await scanQr(uri);
    const params = new URLSearchParams(data.split('?')[1]);
    assert.strictEqual(params.get('secret'), secret);
  });

  await test('QR: TOTP 파라미터(issuer/algorithm/digits/period)가 정확함', async () => {
    const data = await scanQr(uri);
    const p = new URLSearchParams(data.split('?')[1]);
    assert.strictEqual(p.get('issuer'), 'TEV1');
    assert.strictEqual(p.get('algorithm'), 'SHA1');
    assert.strictEqual(p.get('digits'), '6');
    assert.strictEqual(p.get('period'), '30');
  });

  await test('QR: 스캔된 시크릿으로 실제 TOTP 코드가 통과함', async () => {
    const data = await scanQr(uri);
    const scanned = new URLSearchParams(data.split('?')[1]).get('secret');
    const code = totp.generateCode(scanned, Math.floor(Date.now() / 1000 / 30));
    assert.ok(/^\d{6}$/.test(code), `코드 형식 오류: ${code}`);
    assert.strictEqual(totp.verifyCode(scanned, code), true, '스캔한 시크릿으로 검증 실패');
  });

  await test('QR: 한글 계정명도 정상 인코딩/디코딩됨', async () => {
    const kr = totp.otpauthUri({ secret, account: '김철수', issuer: 'TEV1' });
    const data = await scanQr(kr);
    assert.ok(data, '한글 URI 디코딩 실패');
    assert.ok(decodeURIComponent(data).includes('김철수'), '한글 계정명 손실');
  });

  await test('QR: SVG 출력에 스크립트/이벤트가 섞이지 않음', async () => {
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
    assert.ok(svg.startsWith('<svg'), 'SVG 아님');
    assert.ok(!/<script|on\w+\s*=|javascript:/i.test(svg), '위험한 콘텐츠 포함');
  });

  await test('QR: 악의적 시크릿도 스크립트를 주입하지 못함', async () => {
    const evil = totp.otpauthUri({ secret: 'AAA"><script>alert(1)</script>', account: 'x', issuer: 'TEV1' });
    const svg = await QRCode.toString(evil, { type: 'svg', margin: 1, width: 220 });
    assert.ok(!/<script|on\w+\s*=|javascript:/i.test(svg), '스크립트 주입 감지');
  });

  await test('QR: 작은 크기(200px)에서도 스캔 가능함', async () => {
    const data = await scanQr(uri, 200);
    assert.ok(data, '200px QR 디코딩 실패');
    assert.strictEqual(new URLSearchParams(data.split('?')[1]).get('secret'), secret);
  });

  console.log(`\n요약: ${passed}/${passed + failed} 통과`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('qr test error:', e);
  process.exit(1);
});