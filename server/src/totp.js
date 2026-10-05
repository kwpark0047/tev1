'use strict';
/**
 * TOTP (RFC 6238) 구현
 *
 * Google Authenticator / Authy / 1Password 등 표준 인증앱과 호환되는
 * 6자리 코드 기반 2FA를 외부 의존성 없이 구현한다.
 * 사용 알고리즘은 HMAC-SHA1(RFC 4226), 시간 주기는 30초, 자릿수는 6.
 *
 * 보안 관련 결정:
 * - 시크릿은 Base32로 저장/전달한다(인증앤 요구 형식).
 * - 검증은 ±1 단계(총 3개 시간창)만 허용해 시계가 약간 어긋난 폰도 통과시킨다.
 *   더 넓게 허용하면 codes를 추측하기 쉬워지므로 이것만 허용한다.
 * - 상수시간 비교를 사용한다.
 */

const crypto = require('crypto');

const DIGITS = 6;
const PERIOD = 30; // 초
const ALGORITHM = 'sha1';

// ===================== Base32 (RFC 4648) =====================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid Base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ===================== TOTP 핵심 =====================

/** 시크릿 생성 (기본 20바이트 → Base32 32자) */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** 특정 시간(unix 초)의 코드 생성 */
function generateCode(secretBase32, counter) {
  const key = base32Decode(secretBase32);

  // 카운터는 음수가 될 수 없으므로(1970 이전) 0으로 고정한다
  const safeCounter = counter < 0 ? 0 : counter;

  // 8바이트 빅엔디안 카운터
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(safeCounter));

  const hmac = crypto.createHmac(ALGORITHM, key).update(buf).digest();

  // 동적 트렁킹 (RFC 4226 §5.3)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** 현재 시각 기준 코드 */
function currentCode(secretBase32, atMs = Date.now()) {
  return generateCode(secretBase32, Math.floor(atMs / 1000 / PERIOD));
}

/** 코드 검증 (±window 단계) */
function verifyCode(secretBase32, code, { window = 1, atMs = Date.now() } = {}) {
  const normalized = String(code || '').trim();
  if (!/^\d{6}$/.test(normalized)) return false;

  const counter = Math.floor(atMs / 1000 / PERIOD);
  const provided = Buffer.from(normalized);
  // 앞 0이 유지되므로 문자열 비교가 아니라 숫자 비교를 하되,
  // 길이가 고정이라 Buffer 비교가 안전하다. 코드 형식은 이미 검사했다.

  for (let delta = -window; delta <= window; delta += 1) {
    const expected = generateCode(secretBase32, counter + delta);
    const a = Buffer.from(expected);
    if (a.length === provided.length && crypto.timingSafeEqual(a, provided)) {
      return true;
    }
  }
  return false;
}

/** 인증앤용 otpauth:// URI */
function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ===================== 복구 코드 =====================
const RECOVERY_CODE_COUNT = 10;

/** 사람이 옮겨 적기 쉬운 복구 코드 생성 (XXXX-XXXX) */
function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  // crypto로 생성한 40비트 값을 Base32 8자리(40비트)로 표현
  for (let i = 0; i < count; i += 1) {
    const raw = base32Encode(crypto.randomBytes(5)); // 5바이트 → 8문자
    codes.push(raw.slice(0, 4) + '-' + raw.slice(4, 8));
  }
  return codes;
}

/** 복구 코드 정규화 (사용자 입력 편의) */
function normalizeRecoveryCode(code) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean;
}

/** 복구 코드 목록에서 일치 항목 제거 (1회 사용) */
function consumeRecoveryCode(storedCodes, input) {
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return { ok: false, remaining: storedCodes };
  const next = storedCodes.filter((c) => normalizeRecoveryCode(c) !== normalized);
  if (next.length === storedCodes.length) {
    return { ok: false, remaining: storedCodes };
  }
  return { ok: true, remaining: next };
}

/** 백업 코드 유효성 형식 검증 */
function isValidRecoveryCodeFormat(code) {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(code || '').toUpperCase());
}

module.exports = {
  DIGITS,
  PERIOD,
  ALGORITHM,
  RECOVERY_CODE_COUNT,
  base32Encode,
  base32Decode,
  generateSecret,
  generateCode,
  currentCode,
  verifyCode,
  otpauthUri,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  consumeRecoveryCode,
  isValidRecoveryCodeFormat,
};