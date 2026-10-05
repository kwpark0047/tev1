#!/usr/bin/env node
/**
 * TEV1 프론트엔드(index.html) 정적 검사
 *
 * 단일 HTML 파일 안의 인라인 <script> 블록을 추출해 각각 구문을 검증한다.
 * 외부 script 태그(src 속성)는 로드 대상이므로 검사하지 않는다.
 *
 * 사용법: node tests/frontend-check.js
 * 종료코드: 0 = 전부 통과, 1 = 실패
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HTML_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'wemarket1', 'index.html');

function extractInlineScripts(html) {
  // src 속성이 없는 인라인 블록만 추출
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const blocks = [];
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks;
}

function checkBlock(code, index) {
  const tmp = path.join(os.tmpdir(), `tev1_fe_block_${process.pid}_${index}.js`);
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e.stderr && e.stderr.toString()) || e.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function main() {
  if (!fs.existsSync(HTML_PATH)) {
    console.error('HTML 파일을 찾을 수 없습니다:', HTML_PATH);
    process.exit(1);
  }

  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const blocks = extractInlineScripts(html);

  console.log(`대상: ${HTML_PATH}`);
  console.log(`인라인 스크립트 블록: ${blocks.length}개`);

  const external = (html.match(/<script[^>]*\bsrc=/g) || []).length;
  if (external) console.log(`외부 스크립트 태그: ${external}개 (구문 검사 대상 아님)`);

  let failed = 0;
  blocks.forEach((code, i) => {
    const r = checkBlock(code, i + 1);
    if (r.ok) {
      console.log(`PASS  block #${i + 1} (${code.split('\n').length} lines)`);
    } else {
      failed += 1;
      console.log(`FAIL  block #${i + 1}`);
      console.log(r.message.split('\n').slice(0, 8).join('\n'));
    }
  });

  // 추가 검사: Socket.IO 클라이언트 로드가 존재해야 실시간 통신이 동작한다
  // (하드코딩 금지: 정적 src 태그 대신 런타임 동적 로드를 사용한다)
  const hasSocketIoClient = /socket\.io\/socket\.io\.js/.test(html);
  console.log(`${hasSocketIoClient ? 'PASS' : 'FAIL'}  Socket.IO 클라이언트 로드 경로`);
  if (!hasSocketIoClient) failed += 1;

  // 배포 안전성: 하드코딩된 localhost가 남아 있으면 실제 배포에서 실패한다
  const hardcodedLocalhost = [];
  const hlPatterns = [
    { re: /src=["']https?:\/\/localhost:\d+/g, label: '<script src> localhost' },
    { re: /src=["']http:\/\/127\.0\.0\.1:\d+/g, label: '<script src> 127.0.0.1' },
  ];
  // 주석/문서 안의 예시 문자열은 실제 태그가 아니므로 제외한다
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const { re, label } of hlPatterns) {
    const m = htmlNoComments.match(re);
    if (m) hardcodedLocalhost.push(`${label}: ${m.slice(0, 2).join(', ')}`);
  }
  console.log(`${hardcodedLocalhost.length === 0 ? 'PASS' : 'FAIL'}  하드코딩된 localhost 없음 (배포 안전)`);
  if (hardcodedLocalhost.length > 0) {
    failed += 1;
    for (const h of hardcodedLocalhost) console.log(`      ${h}`);
  }

  // 스크립트 태그 개수가 짝을 이루는지 확인
  // 태그를 순서대로 훑어 실제 짝 맞춤을 검증한다 (개수 비교는 부정확)
  const tokens = html.match(/<script(?![^>]*\bsrc=)[^>]*>|<script[^>]*\bsrc=[^>]*>|<\/script>/g) || [];
  let depth = 0;
  let extraClose = -1;
  let unclosedAt = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].startsWith('</')) {
      depth -= 1;
      if (depth < 0 && extraClose === -1) extraClose = i;
    } else {
      if (depth === 0) unclosedAt = i;
      depth += 1;
    }
  }
  const balanced = depth === 0 && extraClose === -1;
  const openCount = tokens.filter((t) => !t.startsWith('</')).length;
  console.log(
    `${balanced ? 'PASS' : 'FAIL'}  script 태그 짝 맞춤 (open=${openCount}, close=${tokens.length - openCount}, 잔여=${depth}, 잉여닫힘=${extraClose})`
  );
  if (!balanced) failed += 1;

  console.log(`\n요약: ${blocks.length + 2 - failed}/${blocks.length + 2} 통과`);
  process.exit(failed ? 1 : 0);
}

main();