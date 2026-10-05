'use strict';
/**
 * 인증 유틸리티
 *
 * 설계 고려사항:
 * - 비밀번호는 scrypt(N=16384, r=8, p=1)로 해시한다. Node 내장 crypto만 사용하므로
 *   외부 의존성 추가 없이 bcrypt급 비용을 확보할 수 있다.
 * - 해시 문자열은 `scrypt$N$r$p$saltB64$hashB64` 형식이라 파라미터를 추후 강화할 수 있다.
 * - 상수시간 비교(timingSafeEqual)를 사용해 비교 시간으로 유추되는 공격을 막는다.
 * - 로그인 실패 시 같은 메시지를 반환해 계정 존재 여부를 노출하지 않는다.
 */

const crypto = require('crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

// 비밀번호 정책
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

/** scrypt 해시 생성 */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_BYTES);
    crypto.scrypt(
      password,
      salt,
      KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (err, derived) => {
        if (err) return reject(err);
        resolve(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`);
      }
    );
  });
}

/** 저장된 해시와 비밀번호 비교 (상수시간) */
function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    if (!stored || typeof stored !== 'string') return resolve(false);

    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    let salt;
    let expected;
    try {
      salt = Buffer.from(parts[4], 'base64');
      expected = Buffer.from(parts[5], 'base64');
    } catch (_) {
      return resolve(false);
    }
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return resolve(false);

    crypto.scrypt(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, derived) => {
      if (err) return resolve(false);
      try {
        resolve(crypto.timingSafeEqual(derived, expected));
      } catch (_) {
        resolve(false);
      }
    });
  });
}

/** 비밀번호 정책 검증 → {ok, error} */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, error: '비밀번호를 입력하세요.' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: '비밀번호가 너무 깁니다.' };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) {
    return { ok: false, error: '비밀번호는 영문 대소문자, 숫자 중 2종 이상을 조합하세요.' };
  }
  return { ok: true };
}

/** 사용자 ID 정책 검증 (로그인 ID로 사용) */
function validateUserId(userId) {
  if (typeof userId !== 'string') return { ok: false, error: '사용자 ID를 입력하세요.' };
  const trimmed = userId.trim();
  if (trimmed.length < 3 || trimmed.length > 64) {
    return { ok: false, error: '사용자 ID는 3~64자여야 합니다.' };
  }
  if (!/^[a-zA-Z0-9._@-]+$/.test(trimmed)) {
    return { ok: false, error: '사용자 ID는 영문/숫자/._@- 만 사용할 수 있습니다.' };
  }
  return { ok: true, value: trimmed };
}

/** 로그인 시도 시 비용을 감추기 위한 더미 해시 (계정 미존재 시 사용) */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'ZG8gbm90LWNvbXBhcmUtaGFzaC1qdXN0LXBhZGQtdG8tbG9vay1tb3JlLWJ5dGVzLWxvbmdlci10by1tYWtlLXNjb3J0LXN0YXRvbmUtc2VjdXJpdHk=';

function dummyVerify() {
  return verifyPassword('timing-equalizer-not-a-real-password', DUMMY_HASH);
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePassword,
  validateUserId,
  dummyVerify,
  MIN_PASSWORD_LENGTH,
};