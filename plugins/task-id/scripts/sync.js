#!/usr/bin/env node
'use strict';
/**
 * 번호 등록부 맞추기 - 이미 쓰고 있는 작업 기록 번호를 원격 ref 로 등록한다.
 *
 * 선점 ref 는 /task-new 로 받은 번호에만 생긴다. 플러그인을 쓰기 전에 만든 문서나 플러그인 없이
 * 만든 문서에는 ref 가 없어서, 그 번호를 다른 세션이 다시 받을 수 있다. 작업 기록은 대부분 기능
 * 브랜치에서 만들어지므로 기본 브랜치 하나만 봐서는 모자란다.
 *
 * 보는 곳:
 *   1. 원격의 모든 브랜치
 *   2. 이 PC 의 모든 로컬 브랜치 (아직 푸시하지 않은 것)
 *   3. 이 PC 의 작업 트리와 형제 워크트리 (아직 커밋하지 않은 것)
 * 찾은 번호 중 ref 가 없는 것을 등록한다. 같은 번호에 다른 문서가 있으면 알리기만 한다.
 *
 * 기본은 조회만 한다. --apply 를 줘야 원격에 등록한다.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULTS = { taskDir: 'docs/tasks', refNamespace: 'refs/task-ids', remote: 'origin', digits: 4 };
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FLOOR = '_floor';
const BATCH = 40;

function gitQuiet(args, opts) {
  opts = opts || {};
  try {
    return { ok: true, out: execFileSync('git', args, {
      encoding: 'utf8', timeout: opts.timeout || 60000, stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input, maxBuffer: 64 * 1024 * 1024 }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '') };
  }
}
function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}
const lastLine = s => s.trim().split('\n').filter(Boolean).pop() || '';

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.indexOf('--apply') >= 0;

  const rootRes = gitQuiet(['rev-parse', '--show-toplevel']);
  if (!rootRes.ok) fail('git 저장소가 아닙니다.');
  const root = rootRes.out.trim();
  const cfg = Object.assign({}, DEFAULTS);
  const cfgFile = path.join(root, '.task-id.json');
  if (fs.existsSync(cfgFile)) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); }
    catch (e) { fail('.task-id.json 을 읽지 못했습니다: ' + e.message); }
  }
  const taskDir = cfg.taskDir.replace(/\/+$/, '');
  const pat = new RegExp('^(TASK-(\\d{4})-([a-z][a-z0-9-]*?)-(\\d{' + cfg.digits + '}))(?:-.*)?\\.md$');

  // id -> stem -> [어디서 봤나]
  const seen = new Map();
  const note = (name, where) => {
    const m = pat.exec(name);
    if (!m) return;
    const id = m[1];
    const stem = name.slice(0, -3);
    if (!seen.has(id)) seen.set(id, new Map());
    const stems = seen.get(id);
    if (!stems.has(stem)) stems.set(stem, []);
    const list = stems.get(stem);
    if (list.length < 3) list.push(where);
  };

  // 1·2. 원격 브랜치와 로컬 브랜치의 끝 커밋
  const rh = gitQuiet(['ls-remote', '--heads', cfg.remote], { timeout: 30000 });
  if (!rh.ok) fail('원격 브랜치 목록을 보지 못했습니다: ' + lastLine(rh.out));
  const tips = [];
  for (const line of rh.out.split('\n')) {
    const at = line.indexOf('\t');
    if (at > 0) tips.push({ sha: line.slice(0, at).trim(), where: line.slice(at + 1).trim().replace('refs/heads/', 'origin/') });
  }
  const remoteCount = tips.length;
  const lh = gitQuiet(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads']);
  let localCount = 0;
  if (lh.ok) {
    for (const line of lh.out.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp > 0) { tips.push({ sha: line.slice(0, sp), where: line.slice(sp + 1).replace('refs/heads/', '') }); localCount++; }
    }
  }

  // 로컬에 없는 원격 끝 커밋만 객체를 받아 온다. 추적 브랜치·FETCH_HEAD 는 건드리지 않는다.
  const missing = tips.filter(t => !gitQuiet(['cat-file', '-e', t.sha + '^{commit}']).ok);
  if (missing.length) {
    const names = missing.map(t => 'refs/heads/' + t.where.replace(/^origin\//, ''));
    for (let i = 0; i < names.length; i += BATCH) {
      const f = gitQuiet(['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', cfg.remote]
        .concat(names.slice(i, i + BATCH)), { timeout: 300000 });
      if (!f.ok) fail('원격 브랜치를 가져오지 못했습니다: ' + lastLine(f.out));
    }
  }

  // 같은 트리는 한 번만 읽는다. 브랜치가 많아도 작업 기록 폴더가 같은 경우가 많다.
  const treeNames = new Map();
  for (const t of tips) {
    const tr = gitQuiet(['rev-parse', '--verify', '--quiet', t.sha + ':' + taskDir]);
    if (!tr.ok) continue;
    const tree = tr.out.trim();
    if (!treeNames.has(tree)) {
      const ls = gitQuiet(['ls-tree', '-r', '--name-only', tree]);
      treeNames.set(tree, ls.ok ? ls.out.split('\n').map(p => path.basename(p.trim())).filter(Boolean) : []);
    }
    for (const name of treeNames.get(tree)) note(name, t.where);
  }

  // 3. 작업 트리와 형제 워크트리 (커밋 전 파일)
  const roots = [root];
  const wt = gitQuiet(['worktree', 'list', '--porcelain']);
  if (wt.ok) {
    for (const line of wt.out.split('\n')) {
      if (line.indexOf('worktree ') === 0) {
        const p = line.slice(9).trim();
        if (p && path.resolve(p) !== path.resolve(root)) roots.push(p);
      }
    }
  }
  const walk = (dir, depth, where) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1, where);
      else note(e.name, where);
    }
  };
  for (const r of roots) walk(path.join(r, taskDir), 0, '작업 트리 ' + path.basename(r));

  // 원격에 이미 있는 ref 와 바닥 표시
  const lr = gitQuiet(['ls-remote', cfg.remote, cfg.refNamespace + '/*'], { timeout: 30000 });
  if (!lr.ok) fail('원격의 ref 목록을 보지 못했습니다: ' + lastLine(lr.out));
  const head = cfg.refNamespace + '/';
  const floorHead = head + FLOOR + '/';
  const have = new Set();
  const floors = new Map();
  for (const line of lr.out.split('\n')) {
    const at = line.indexOf('\t');
    if (at < 0) continue;
    const name = line.slice(at + 1).trim();
    if (name.indexOf(floorHead) === 0) {
      const id = name.slice(floorHead.length);
      const cut = id.lastIndexOf('-');
      floors.set(id.slice(0, cut), Math.max(floors.get(id.slice(0, cut)) || 0, parseInt(id.slice(cut + 1), 10)));
    } else if (name.indexOf(head) === 0) {
      have.add(name.slice(head.length));
    }
  }

  const ids = [...seen.keys()].sort();
  const toRegister = [];
  let covered = 0;
  for (const id of ids) {
    if (have.has(id)) continue;
    const cut = id.lastIndexOf('-');
    if ((floors.get(id.slice(0, cut)) || 0) >= parseInt(id.slice(cut + 1), 10)) { covered++; continue; }
    toRegister.push(id);
  }
  const duplicates = ids.filter(id => seen.get(id).size > 1).map(id => ({
    id: id,
    docs: [...seen.get(id).entries()].map(([stem, where]) => ({ doc: stem, seenIn: where })),
  }));

  const summary = {
    ok: true,
    scanned: { remoteBranches: remoteCount, localBranches: localCount, worktrees: roots.length, distinctTrees: treeNames.size },
    numbers: ids.length,
    alreadyRegistered: ids.length - toRegister.length - covered,
    coveredByFloor: covered,
    toRegister: toRegister.length,
    sample: toRegister.slice(0, 8),
    duplicates: duplicates,
  };

  if (!apply || !toRegister.length) {
    summary.registered = 0;
    if (!apply && toRegister.length) summary.note = '조회만 했습니다. 등록하려면 --apply 를 주세요.';
    console.log(JSON.stringify(summary));
    return;
  }

  // 등록 - 없을 때만 만든다. 그 사이 누가 /task-new 로 같은 번호를 받았으면 그쪽이 이긴다.
  let registered = 0;
  const rejected = [];
  const failures = [];
  for (let i = 0; i < toRegister.length; i += BATCH) {
    const chunk = toRegister.slice(i, i + BATCH);
    const leases = [];
    const specs = [];
    for (const id of chunk) {
      const first = seen.get(id).entries().next().value;
      const msg = 'register ' + id + ' doc=' + first[0] + ' seen=' + first[1][0] +
                  ' pid=' + process.pid + ' t=' + Date.now() + ' r=' + Math.random().toString(36).slice(2) + '\n';
      const made = gitQuiet(['commit-tree', EMPTY_TREE], { input: msg });
      if (!made.ok) { failures.push(id + ': 객체를 만들지 못함'); continue; }
      const ref = head + id;
      leases.push('--force-with-lease=' + ref + ':');
      specs.push(made.out.trim() + ':' + ref);
    }
    if (!specs.length) continue;
    const res = gitQuiet(['push', '--porcelain'].concat(leases, [cfg.remote], specs), { timeout: 180000 });
    for (const line of res.out.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const ref = (parts[1].split(':')[1] || '').trim();
      const id = ref.indexOf(head) === 0 ? ref.slice(head.length) : ref;
      if (parts[0] === '*') registered++;
      else if (parts[0] === '!') rejected.push(id);
    }
    if (!res.ok && registered === 0 && !rejected.length) failures.push(lastLine(res.out));
  }
  summary.registered = registered;
  if (rejected.length) summary.rejected = rejected;
  if (failures.length) summary.failures = failures.slice(0, 3);
  console.log(JSON.stringify(summary));
}

main();
