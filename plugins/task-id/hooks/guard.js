#!/usr/bin/env node
'use strict';
/**
 * 안전망 — 예약을 거치지 않고 만들어진 작업 기록 파일을 잡는다.
 *
 * 발급은 /task-new 가 한다. 이 훅은 그 커맨드를 거치지 않고 손으로 만든 경우만 알린다.
 * 막지 않는다. 경고만 하고 비켜선다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

function claimedIds(cwd) {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-dir'],
      { encoding: 'utf8', cwd: cwd, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
if (claimedIds(cwd).indexOf(id) >= 0) process.exit(0);

console.log(
  '[task-id] ' + id + ' 는 예약 기록에 없습니다. 목록을 보고 고른 번호라면 다른 세션과 겹칠 수 있습니다.\n' +
  '          번호는 /task-new 로 받으세요. 이미 쓴 번호라면 그대로 두되, 겹치면 바꿔야 합니다.'
);
process.exit(0);
