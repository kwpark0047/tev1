'use strict';
/**
 * 메일 발송 계층
 *
 * SMTP 설정이 있으면 실제 발송하고, 없으면 개발용으로:
 *   1) outbox 배열에 보관 (테스트에서 확인 가능)
 *   2) outbox.jsonl 파일에 append (수신자가 직접 확인 가능)
 *   3) 콘솔에 요약 출력
 *
 * 이 방식 덕분에 환경변수가 없어도 인증·초대 흐름을 끝까지 검증할 수 있다.
 * 운영에서는 반드시 SMTP_* 를 설정해야 하며, 미설정 상태를 Prod로 착각하지 않도록
 * `isConfigured()` / `mode` 로 명시적으로 알린다.
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const CONFIG = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 0),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || 'TEV1 <no-reply@tev1.local>',
  // 발송 후 보존할 메일 개수(메모리)
  outboxLimit: Number(process.env.MAIL_OUTBOX_LIMIT || 200),
  outboxFile: process.env.MAIL_OUTBOX_FILE || path.join(process.cwd(), 'outbox.jsonl'),
};

const configured = Boolean(CONFIG.host && CONFIG.port);

let transport = null;
if (configured) {
  transport = nodemailer.createTransport({
    host: CONFIG.host,
    port: CONFIG.port,
    secure: CONFIG.secure,
    auth: CONFIG.user ? { user: CONFIG.user, pass: CONFIG.pass } : undefined,
  });
}

// 최근 발송 메일(테스트/디버깅용)
const outbox = [];

function isConfigured() {
  return configured;
}

function mode() {
  return configured ? 'smtp' : 'dev-outbox';
}

/** 개발 모드: 파일에 append */
function persistToFile(entry) {
  try {
    fs.appendFileSync(CONFIG.outboxFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.warn('outbox 파일 기록 실패:', e.message);
  }
}

function htmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)}</title></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,'Malgun Gothic',system-ui,sans-serif;color:#1c2030;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;">
    <div style="font-size:18px;font-weight:700;margin-bottom:16px;">TEV1</div>
    ${bodyHtml}
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e6e8ee;color:#8b90a0;font-size:12px;line-height:1.6;">
      이 메일은 TEV1에서 자동 발송되었습니다. 요청하지 않았다면 무시하세요.
    </div>
  </div>
</body></html>`;
}

const BUTTON = (url, label) =>
  `<a href="${htmlEscape(url)}" style="display:inline-block;background:#191b2e;color:#f5f2e6;padding:12px 22px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">${htmlEscape(label)}</a>`;

/**
 * 메일 1건 발송
 * @returns {Promise<{ok:boolean, mode:string, messageId?:string, error?:string}>}
 */
async function send({ to, subject, html, text }) {
  const at = new Date().toISOString();
  const entry = { at, to, subject, html, text };

  if (!configured) {
    outbox.push(entry);
    if (outbox.length > CONFIG.outboxLimit) outbox.shift();
    persistToFile(entry);
    console.log(`[mail:dev-outbox] → ${to} | ${subject}`);
    return { ok: true, mode: 'dev-outbox' };
  }

  try {
    const info = await transport.sendMail({ from: CONFIG.from, to, subject, html, text });
    outbox.push(entry);
    if (outbox.length > CONFIG.outboxLimit) outbox.shift();
    return { ok: true, mode: 'smtp', messageId: info.messageId };
  } catch (e) {
    console.error('메일 발송 실패:', e.message);
    return { ok: false, mode: 'smtp', error: e.message };
  }
}

// ---------- 템플릿 ----------

function verificationEmail({ link, name }) {
  return {
    subject: '[TEV1] 이메일 인증을 완료해 주세요',
    text: `${name || '안녕하세요'}, 아래 링크를 열어 이메일 인증을 완료해 주세요.\n\n${link}\n\n24시간 안에 완료하지 않으면 링크가 만료됩니다.`,
    html: layout('이메일 인증', `
      <p style="margin:0 0 16px;line-height:1.7;">${htmlEscape(name || '안녕하세요')}, TEV1에 가입해 주셔서 감사합니다.</p>
      <p style="margin:0 0 20px;line-height:1.7;color:#4a5065;">아래 버튼을 눌러 이메일 주소를 인증해 주세요.</p>
      ${BUTTON(link, '이메일 인증하기')}
      <p style="margin:20px 0 0;font-size:12px;color:#8b90a0;word-break:break-all;">버튼이 동작하지 않으면 아래 주소를 복사해 브라우저에 붙여 넣으세요:<br>${htmlEscape(link)}</p>
      <p style="margin:14px 0 0;font-size:12px;color:#8b90a0;">이 링크는 24시간 후 만료됩니다.</p>
    `),
  };
}

function passwordResetEmail({ link, name }) {
  return {
    subject: '[TEV1] 비밀번호 재설정 안내',
    text: `${name || '안녕하세요'}, 비밀번호 재설정을 위해 아래 링크를 열어 주세요.\n\n${link}\n\n1시간 후 만료됩니다. 요청하지 않으셨다면 이 메일을 무시하세요.`,
    html: layout('비밀번호 재설정', `
      <p style="margin:0 0 16px;line-height:1.7;">${htmlEscape(name || '안녕하세요')}, 비밀번호 재설정 요청이 접수되었습니다.</p>
      ${BUTTON(link, '비밀번호 재설정하기')}
      <p style="margin:20px 0 0;font-size:12px;color:#8b90a0;word-break:break-all;">버튼이 동작하지 않으면 아래 주소를 복사해 사용하세요:<br>${htmlEscape(link)}</p>
      <p style="margin:14px 0 0;font-size:12px;color:#c0392b;font-weight:600;">
        본인이 요청하지 않았다면 비밀번호를 변경하지 마세요. 이 링크는 1시간 후 만료됩니다.
      </p>
    `),
  };
}

function passwordSetupEmail({ link, name }) {
  return {
    subject: '[TEV1] 비밀번호 설정 안내',
    text: `${name || '안녕하세요'}, 계정 초기화를 위해 아래 링크를 열어 새 비밀번호를 설정해 주세요.\n\n${link}\n\n7일 후 만료됩니다. 요청하지 않으셨다면 이 메일을 무시하세요.`,
    html: layout('비밀번호 설정', `
      <p style="margin:0 0 16px;line-height:1.7;">${htmlEscape(name || '안녕하세요')}, 계정 로그인을 위한 비밀번호 설정이 요청되었습니다.</p>
      <p style="margin:0 0 20px;line-height:1.7;color:#4a5065;">아래 버튼을 눌러 새 비밀번호를 설정해 주세요.</p>
      ${BUTTON(link, '비밀번호 설정하기')}
      <p style="margin:20px 0 0;font-size:12px;color:#8b90a0;word-break:break-all;">버튼이 동작하지 않으면 아래 주소를 복사해 사용하세요:<br>${htmlEscape(link)}</p>
      <p style="margin:14px 0 0;font-size:12px;color:#c0392b;font-weight:600;">
        본인이 요청하지 않았다면 이 링크를 사용하지 마세요. 7일 후 만료됩니다.
      </p>
    `),
  };
}

function orgInviteEmail({ link, orgName, role, inviterName }) {
  const roleKo = { admin: '관리자', member: '멤버', viewer: '열람자' }[role] || role;
  return {
    subject: `[TEV1] ${orgName} 조직 초대`,
    text: `${inviterName || '관리자'}님이 귀하를 "${orgName}" 조직에 ${roleKo}(으)로 초대했습니다.\n\n초대 수락: ${link}\n\n링크는 7일 후 만료됩니다.`,
    html: layout('조직 초대', `
      <p style="margin:0 0 16px;line-height:1.7;">
        ${htmlEscape(inviterName || '관리자')}님이 귀하를
        <strong>${htmlEscape(orgName)}</strong> 조직에 <strong>${htmlEscape(roleKo)}</strong>로 초대했습니다.
      </p>
      ${BUTTON(link, '초대 수락하기')}
      <p style="margin:20px 0 0;font-size:12px;color:#8b90a0;word-break:break-all;">
        버튼이 동작하지 않으면 아래 주소를 열어 주세요:<br>${htmlEscape(link)}
      </p>
      <p style="margin:14px 0 0;font-size:12px;color:#8b90a0;">
        수락하려면 TEV1 계정으로 로그인한 상태여야 합니다. 이 링크는 7일 후 만료됩니다.
      </p>
    `),
  };
}

/** 최근 발송 메일 조회 (테스트/디버깅) */
function recentMails(limit = 10) {
  return outbox.slice(-limit).map((m) => ({ at: m.at, to: m.to, subject: m.subject }));
}

/** 특정 수신자의 가장 최근 메일 (테스트용) */
function lastMailTo(to) {
  for (let i = outbox.length - 1; i >= 0; i -= 1) {
    if (outbox[i].to === to) return outbox[i];
  }
  return null;
}

/** 발송 검증 (SMTP) */
async function verify() {
  if (!configured) return { ok: true, mode: 'dev-outbox', note: 'SMTP 미설정 - dev-outbox 모드' };
  try {
    await transport.verify();
    return { ok: true, mode: 'smtp' };
  } catch (e) {
    return { ok: false, mode: 'smtp', error: e.message };
  }
}

module.exports = {
  passwordSetupEmail,
  send,
  verificationEmail,
  passwordResetEmail,
  orgInviteEmail,
  isConfigured,
  mode,
  recentMails,
  lastMailTo,
  verify,
  config: CONFIG,
};