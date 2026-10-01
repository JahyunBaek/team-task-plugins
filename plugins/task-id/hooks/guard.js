#!/usr/bin/env node
'use strict';
/**
 * 안전망 — 선점을 거치지 않고 새로 만들어진 작업 기록 파일을 잡는다.
 *
 * 발급은 /task-new 가 한다. 이 훅은 그 커맨드를 거치지 않고 손으로 만든 경우만 알린다.
 * 저장소가 이미 아는 파일(옛 문서 수정)은 건드리지 않는다.
 * 막지 않는다. 경고만 하고 비켜선다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(args, cwd) {
  return execFileSync('git', args,
    { encoding: 'utf8', cwd: cwd, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
}

function readPayload() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); }
  catch (e) { return {}; }
}

/** 파일 이름에서 TASK-연도-도메인-번호 를 떼어낸다. 아니면 null. */
function idFromName(name) {
  if (name.indexOf('TASK-') !== 0) return null;
  const parts = name.split('-');
  if (parts.length < 4) return null;
  const year = parts[1];
  if (year.length !== 4 || isNaN(Number(year))) return null;
  const num = parts[3].split('.')[0];
  if (!num.length || isNaN(Number(num))) return null;
  return parts[0] + '-' + parts[1] + '-' + parts[2] + '-' + num;
}

/** 저장소가 이미 아는 파일인가. 옛 문서를 고치는 중이면 참견할 일이 아니다. */
function alreadyTracked(file, cwd) {
  try { git(['ls-files', '--error-unmatch', '--', file], cwd); return true; }
  catch (e) { return false; }
}

function claimedIds(cwd) {
  try {
    const dir = git(['rev-parse', '--git-dir'], cwd).trim();
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'task-id-claims.json'), 'utf8'));
    return Array.isArray(list) ? list.map(x => x && x.id) : [];
  } catch (e) { return []; }
}

const payload = readPayload();
const file = payload && payload.tool_input && payload.tool_input.file_path;
if (!file) process.exit(0);

const id = idFromName(path.basename(String(file)));
if (!id) process.exit(0);

const cwd = payload.cwd || process.cwd();
if (alreadyTracked(file, cwd)) process.exit(0);
if (claimedIds(cwd).indexOf(id) >= 0) process.exit(0);

console.log(
  '[task-id] ' + id + ' 를 선점하지 않고 새 작업 기록을 만들었습니다.\n' +
  '          목록을 보고 고른 번호라면 다른 세션이 같은 번호를 쓰고 있을 수 있습니다.\n' +
  '          번호는 /task-new 로 받으세요.'
);
process.exit(0);
