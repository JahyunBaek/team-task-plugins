#!/usr/bin/env node
'use strict';
/**
 * 안전망 — 새로 만들어진 작업 기록 파일을 본다. 막지 않고 경고만 한다.
 *
 * 발급은 /task-new 가 한다. 이 훅은 그걸 거치지 않았거나, 거쳤어도 어긋난 경우를 알린다.
 *   1. 폴더 이름과 번호의 도메인이 다르다
 *   2. 같은 번호의 다른 문서가 이미 있다 (이 트리 · 형제 워크트리 · 원격 기준 브랜치)
 *   3. /task-new 로 받은 번호가 아니다
 *
 * 저장소가 이미 아는 파일(옛 문서 수정)은 건드리지 않는다.
 * 출력은 짧게 둔다. 훅 출력도 대화 문맥에 쌓인다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveBranch, committedPaths } = require('../scripts/branch.js');

const DEFAULTS = { taskDir: 'docs/tasks', remote: 'origin', defaultBranch: null };

function git(args, cwd, timeout) {
  return execFileSync('git', args,
    { encoding: 'utf8', cwd: cwd, timeout: timeout || 5000, stdio: ['pipe', 'pipe', 'pipe'] });
}
function gitTry(args, cwd, timeout) {
  try { return git(args, cwd, timeout); } catch (e) { return null; }
}

function readPayload() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); }
  catch (e) { return {}; }
}

/** 파일 이름에서 { id, year, domain, num } 을 뗀다. TASK-연도-도메인-번호 꼴이 아니면 null. */
function parseName(name) {
  if (name.indexOf('TASK-') !== 0) return null;
  const parts = name.split('-');
  if (parts.length < 4) return null;
  const year = parts[1];
  if (year.length !== 4 || isNaN(Number(year))) return null;
  let i = 2;
  const dom = [];
  while (i < parts.length) {
    const seg = parts[i].split('.')[0];
    if (seg.length && !isNaN(Number(seg))) break;
    dom.push(parts[i]); i++;
  }
  if (i >= parts.length || !dom.length) return null;
  const num = parts[i].split('.')[0];
  const domain = dom.join('-');
  return { id: 'TASK-' + year + '-' + domain + '-' + num, year: year, domain: domain, num: num };
}

/** 저장소가 이미 아는 파일인가. 옛 문서를 고치는 중이면 참견할 일이 아니다. */
function alreadyTracked(file, cwd) {
  return gitTry(['ls-files', '--error-unmatch', '--', file], cwd) !== null;
}

function claimedIds(cwd) {
  try {
    const dir = git(['rev-parse', '--git-dir'], cwd).trim();
    const list = JSON.parse(fs.readFileSync(path.resolve(cwd, dir, 'task-id-claims.json'), 'utf8'));
    return Array.isArray(list) ? list.map(x => x && x.id) : [];
  } catch (e) { return []; }
}

function worktreeRoots(root) {
  const roots = new Set([path.resolve(root)]);
  const out = gitTry(['worktree', 'list', '--porcelain'], root);
  if (out) {
    for (const line of out.split('\n')) {
      if (line.indexOf('worktree ') === 0) roots.add(path.resolve(line.slice(9).trim()));
    }
  }
  return [...roots];
}

/**
 * 같은 번호를 쓰는 다른 문서의 이름들.
 * 원격은 짧게 가져와 보고, 실패하면 마지막으로 가져온 기준으로 본다. 훅이 작업을 막아선 안 된다.
 */
function sameNumberElsewhere(info, stem, root, cfg) {
  const prefix = info.id + '-';
  const found = new Set();
  const consider = name => {
    const s = name.replace(/\.md$/, '');
    if (s !== stem && (s === info.id || s.indexOf(prefix) === 0)) found.add(s);
  };

  for (const r of worktreeRoots(root)) {
    try { for (const f of fs.readdirSync(path.join(r, cfg.taskDir, info.domain))) consider(f); }
    catch (e) { /* 그 트리에는 이 도메인 폴더가 없다 */ }
  }

  const base = committedPaths(cfg, cfg.remote, [], root, 8000);
  if (base.ok) {
    for (const p of base.paths) consider(path.basename(p));
  } else {
    // 원격에 못 닿으면 마지막으로 가져온 추적 브랜치로 본다.
    const picked = resolveBranch(cfg, cfg.remote, [], root, 3000);
    if (picked.branch) {
      const ref = 'refs/remotes/' + cfg.remote + '/' + picked.branch.replace(/^refs\/heads\//, '');
      const out = gitTry(['ls-tree', '-r', '--name-only', ref, '--', cfg.taskDir + '/' + info.domain], root, 8000);
      if (out) for (const p of out.split('\n')) if (p.trim()) consider(path.basename(p.trim()));
    }
  }
  return [...found].sort();
}

function main() {
  const payload = readPayload();
  const file = payload && payload.tool_input && payload.tool_input.file_path;
  if (!file) return;

  const info = parseName(path.basename(String(file)));
  if (!info) return;

  const cwd = payload.cwd || process.cwd();
  if (alreadyTracked(file, cwd)) return;

  const top = gitTry(['rev-parse', '--show-toplevel'], cwd);
  if (!top) return;
  const root = top.trim();

  const cfg = Object.assign({}, DEFAULTS);
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(root, '.task-id.json'), 'utf8'))); }
  catch (e) { /* 설정 파일이 없으면 기본값 */ }

  // 작업 기록 폴더 밖이면 판단하지 않는다.
  const rel = path.relative(root, path.resolve(cwd, String(file))).split(path.sep).join('/');
  const taskDir = cfg.taskDir.replace(/\/+$/, '') + '/';
  if (rel.indexOf(taskDir) !== 0) return;
  const folder = rel.slice(taskDir.length).split('/')[0];
  if (folder.indexOf('_') === 0) return;    // 양식·보관용 폴더
  const stem = path.basename(rel).replace(/\.md$/, '');

  const msgs = [];
  if (folder !== info.domain && rel.slice(taskDir.length).indexOf('/') > 0) {
    msgs.push('[task-id] ' + rel + '\n' +
              "          폴더는 '" + folder + "' 인데 번호의 도메인은 '" + info.domain + "' 입니다. 둘을 맞추세요.");
  }

  const dupes = sameNumberElsewhere(info, stem, root, cfg);
  if (dupes.length) {
    const shown = dupes.slice(0, 2).join(', ') + (dupes.length > 2 ? ' 외 ' + (dupes.length - 2) + '건' : '');
    msgs.push('[task-id] ' + info.id + ' 는 이미 있습니다 - ' + shown + '\n' +
              '          번호를 /task-new 로 다시 받으세요.');
  } else if (claimedIds(cwd).indexOf(info.id) < 0) {
    msgs.push('[task-id] ' + info.id + ' 를 선점하지 않고 새 작업 기록을 만들었습니다.\n' +
              '          목록을 보고 고른 번호라면 다른 세션이 같은 번호를 쓰고 있을 수 있습니다.\n' +
              '          번호는 /task-new 로 받으세요.');
  }

  if (msgs.length) console.log(msgs.join('\n'));
}

main();
process.exit(0);
