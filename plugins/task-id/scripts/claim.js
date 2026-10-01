#!/usr/bin/env node
'use strict';
/**
 * 작업 번호 발급 - 목록에서 고르지 않고 원격에서 선점한다.
 *
 * 번호를 고른 뒤 원격에 그 번호 이름으로 ref 를 만든다(refs/task-ids/<번호>).
 * 깃은 같은 이름의 ref 를 두 번 만들지 못한다. "없을 때만 만들기"로 밀면
 * 같은 번호를 동시에 노린 세션 중 하나만 성공하고, 거절받은 쪽은 다음 번호로 넘어간다.
 * 판정을 원격이 하므로 다른 PC 에서 들어온 세션도 같이 걸린다.
 *
 * ref 가 가리키는 것은 빈 트리 위의 커밋 하나다. 작업 폴더는 건드리지 않는다.
 * 메시지에 번호·프로세스·시각·난수를 적어 매번 다른 객체가 되게 한다 -
 * 같은 객체면 "방금 내가 잡은 것"과 "이미 있던 것"을 구별할 수 없기 때문이다.
 *
 * 후보 번호는 네 곳에서 본 최대값 + 1 이다.
 *   1. 이 작업 트리의 작업 기록 파일
 *   2. 형제 워크트리의 작업 기록 파일 (아직 커밋 전인 것까지)
 *   3. 원격의 선점 ref 와 바닥 표시
 *   4. 원격 기준 브랜치에 커밋된 작업 기록 파일
 * 4 가 없으면, 체크아웃이 뒤처져 있을 때 ref 없이 만들어진 문서(플러그인 이전 문서 등)의
 * 번호를 다시 고를 수 있다.
 *
 * 원격을 못 보면 멈춘다(기본값). offlinePolicy 가 warn 이면 1·2 만으로 잠정 번호를 준다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { committedPaths } = require('./branch.js');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULTS = {
  taskDir: 'docs/tasks',
  refNamespace: 'refs/task-ids',
  remote: 'origin',
  digits: 4,
  offlinePolicy: 'block',
  maxAttempts: 25,
  defaultBranch: null,
};

function git(args, opts) {
  opts = opts || {};
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: opts.timeout || 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input,
  });
}
function gitQuiet(args, opts) {
  try { return { ok: true, out: git(args, opts) }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.stdout || e.message || '') }; }
}

function fail(msg, extra) {
  console.log(JSON.stringify(Object.assign({ ok: false, error: msg }, extra || {})));
  process.exit(1);
}

/** 이름 앞머리가 prefix 면 뒤에 붙은 숫자를 돌려준다. 아니면 -1. */
function numberAfter(name, prefix) {
  if (name.indexOf(prefix) !== 0) return -1;
  const tail = name.slice(prefix.length);
  let i = 0;
  while (i < tail.length && tail[i] >= '0' && tail[i] <= '9') i++;
  return i > 0 ? parseInt(tail.slice(0, i), 10) : -1;
}

function numbersInTree(dir, prefix) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else { const n = numberAfter(e.name, prefix); if (n >= 0) found.push(n); }
    }
  };
  walk(dir, 0);
  return found;
}

function siblingWorktrees(root) {
  const r = gitQuiet(['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const head = 'worktree ';
  return r.out.split('\n')
    .filter(l => l.indexOf(head) === 0)
    .map(l => l.slice(head.length).trim())
    .filter(p => p && path.resolve(p) !== path.resolve(root));
}

/**
 * 발급한 번호를 저장소에 적어 둔다. 훅이 이 목록을 보고 선점 없이 만든 파일을 잡는다.
 * 워크트리끼리 함께 쓰는 자리(--git-common-dir)에 둔다 - 주 트리에서 받은 번호로
 * 워크트리에서 파일을 만들어도 훅이 같은 목록을 본다.
 */
function claimsFile() {
  const g = gitQuiet(['rev-parse', '--git-common-dir']);
  return g.ok ? path.resolve(process.cwd(), g.out.trim(), 'task-id-claims.json') : null;
}
function readClaims() {
  const file = claimsFile();
  if (!file) return [];
  try { const list = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(list) ? list : []; }
  catch (e) { return []; }
}
function recordClaim(id, provisional, extra) {
  const file = claimsFile();
  if (!file) return;
  const list = readClaims();
  list.push(Object.assign({ id: id, at: new Date().toISOString(), provisional: !!provisional }, extra || {}));
  try { fs.writeFileSync(file, JSON.stringify(list, null, 2)); } catch (e) { /* 기록 실패가 발급을 막지는 않는다 */ }
}

/** TASK-<연도>-<도메인>-<번호> 를 뜯는다. 아니면 null. */
function parseIdStr(id) {
  const parts = String(id).split('-');
  if (parts.length < 4 || parts[0] !== 'TASK') return null;
  const year = parts[1];
  const numTxt = parts[parts.length - 1];
  const domain = parts.slice(2, parts.length - 1).join('-');
  if (year.length !== 4 || isNaN(Number(year)) || !domain || !numTxt.length || isNaN(Number(numTxt))) return null;
  return { year: year, domain: domain, num: parseInt(numTxt, 10), prefix: 'TASK-' + year + '-' + domain + '-' };
}

/** 이름이 정확히 그 번호인 문서들(뒤에 설명이 붙은 것 포함). */
function namesWithNumber(names, prefix, num) {
  return names.filter(n => numberAfter(n, prefix) === num);
}

/**
 * --adopt <번호> : 플러그인을 붙이기 전부터 쓰고 있던 번호를 ref 로 등록한다.
 *
 * 커밋 전인 문서는 다른 PC 에서 안 보이고 ref 도 없다. 그대로 두면 다른 PC 가 같은 번호를 받는다.
 * 이 PC 의 작업 트리에 그 번호의 문서가 있을 때만 등록한다. 기준 브랜치에 같은 번호의
 * 다른 문서가 있으면 이미 겹친 것이라 멈춘다.
 */
function adopt(id, cfg, root, branchArgv) {
  const p = parseIdStr(id);
  if (!p) fail('번호 형식이 아닙니다: ' + id + ' (예: TASK-2026-core-0042)');
  const canon = p.prefix + String(p.num).padStart(cfg.digits, '0');

  const local = [];
  for (const base of [root].concat(siblingWorktrees(root))) {
    const d = path.join(base, cfg.taskDir, p.domain);
    try { for (const f of fs.readdirSync(d)) local.push(f); } catch (e) { /* 그 트리에는 이 도메인이 없다 */ }
  }
  const mine = namesWithNumber(local, p.prefix, p.num);
  if (!mine.length) fail('이 PC 의 작업 트리에 ' + canon + ' 문서가 없습니다. 등록은 이미 쓰고 있는 번호에만 합니다.');

  const base = committedPaths(cfg, cfg.remote, branchArgv, root);
  if (!base.ok) fail(base.error);
  const theirs = namesWithNumber(base.paths.map(x => path.basename(x)), p.prefix, p.num);
  if (theirs.length) {
    const clash = mine.filter(n => theirs.indexOf(n) < 0);
    if (clash.length) {
      fail(canon + ' 는 기준 브랜치에 다른 문서로 이미 있습니다 - ' + theirs.join(', ') +
           '. 이쪽 문서(' + clash.join(', ') + ')의 번호를 /task-new 로 다시 받으세요.', { id: canon });
    }
    console.log(JSON.stringify({ ok: true, id: canon, adopted: false,
      message: '이미 기준 브랜치에 커밋된 번호라 등록할 필요가 없습니다.' }));
    return;
  }

  const ref = cfg.refNamespace + '/' + canon;
  const msg = 'adopt ' + canon + ' pid=' + process.pid + ' t=' + Date.now() +
              ' r=' + Math.random().toString(36).slice(2) + '\n';
  const made = gitQuiet(['commit-tree', EMPTY_TREE], { input: msg });
  if (!made.ok) fail('등록용 객체를 만들지 못했습니다: ' + made.out.trim());
  const push = gitQuiet(['push', '--force-with-lease=' + ref + ':', cfg.remote, made.out.trim() + ':' + ref], { timeout: 15000 });
  if (!push.ok) {
    const why = push.out.toLowerCase();
    const taken = why.indexOf('rejected') >= 0 || why.indexOf('stale info') >= 0 ||
                  why.indexOf('already exists') >= 0 || why.indexOf('non-fast-forward') >= 0;
    if (!taken) fail('등록에 실패했습니다: ' + (push.out.trim().split('\n').filter(Boolean).pop() || ''), { id: canon });
    const ours = readClaims().some(c => c && c.id === canon);
    if (ours) {
      console.log(JSON.stringify({ ok: true, id: canon, adopted: false, message: '이미 이 PC 에서 등록한 번호입니다.' }));
      return;
    }
    fail(canon + ' 는 원격에 이미 선점돼 있습니다. 다른 PC 나 세션이 같은 번호를 잡은 것입니다. ' +
         '이쪽 문서(' + mine.join(', ') + ')의 번호를 /task-new 로 다시 받으세요.', { id: canon });
  }
  recordClaim(canon, false, { adopted: true });
  console.log(JSON.stringify({ ok: true, id: canon, adopted: true, ref: ref, files: mine }));
}

function main() {
  // --dry-run : 선점하지 않고 "지금 받으면 나올 번호"와 근거별 최대값만 보여 준다.
  // --branch <b> : 기준 브랜치를 이번 한 번만 지정한다.
  // --adopt <번호> : 플러그인 이전부터 쓰던 번호를 ref 로 등록한다.
  const raw = process.argv.slice(2);
  const dryRun = raw.indexOf('--dry-run') >= 0;
  const valueOf = name => { const i = raw.indexOf(name); return (i >= 0 && raw[i + 1]) ? raw[i + 1] : null; };
  const branchVal = valueOf('--branch');
  const adoptId = valueOf('--adopt');
  const branchArgv = branchVal ? ['--branch', branchVal] : [];
  const skip = new Set();
  for (const name of ['--branch', '--adopt']) {
    const i = raw.indexOf(name);
    if (i >= 0) { skip.add(i); skip.add(i + 1); }
  }
  const argv = raw.filter((a, i) => a !== '--dry-run' && !skip.has(i));

  const rootRes = gitQuiet(['rev-parse', '--show-toplevel']);
  if (!rootRes.ok) fail('git 저장소가 아닙니다.');
  const root = rootRes.out.trim();

  const cfg = Object.assign({}, DEFAULTS);
  const cfgFile = path.join(root, '.task-id.json');
  if (fs.existsSync(cfgFile)) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); }
    catch (e) { fail('.task-id.json 을 읽지 못했습니다: ' + e.message); }
  }

  if (adoptId) return adopt(adoptId, cfg, root, branchArgv);

  const domain = argv[0];
  if (!domain) fail('도메인을 지정하세요. 예: /task-new core 번호-발급');
  const slug = argv.slice(1).join(' ').split(' ').filter(Boolean).join('-');

  const year = new Date().getFullYear();
  const prefix = 'TASK-' + year + '-' + domain + '-';
  const pad = n => String(n).padStart(cfg.digits, '0');

  // 근거별로 따로 모은다. 미리보기에서 어느 근거가 번호를 밀어 올렸는지 보여 주려고.
  const fromTree = [];
  const fromRefs = [];
  const fromBase = [];
  const scan = base => {
    const d = path.join(base, cfg.taskDir);
    if (fs.existsSync(d)) for (const n of numbersInTree(d, prefix)) fromTree.push(n);
  };
  scan(root);
  const worktrees = siblingWorktrees(root);
  for (const w of worktrees) scan(w);

  let offline = false;
  let offlineReason = '';
  // 선점 ref 와 함께 바닥 표시(_floor)도 읽는다. 정리로 ref 를 지운 뒤에는 바닥 표시만
  // 남는데, 그것까지 봐야 뒤처진 체크아웃이 이미 쓰인 번호를 다시 집지 않는다.
  const ls = gitQuiet(['ls-remote', cfg.remote,
    cfg.refNamespace + '/' + prefix + '*',
    cfg.refNamespace + '/_floor/' + prefix + '*'], { timeout: 10000 });
  if (ls.ok) {
    for (const line of ls.out.split('\n')) {
      const at = line.indexOf(prefix);
      if (at < 0) continue;
      const n = numberAfter(line.slice(at), prefix);
      if (n >= 0) fromRefs.push(n);
    }
  } else {
    offline = true;
    const low = ls.out.toLowerCase();
    offlineReason = (low.indexOf('could not read') >= 0 || low.indexOf('authentication') >= 0)
      ? '원격 인증에 실패했습니다'
      : ((low.indexOf('timed out') >= 0 || low.indexOf('timeout') >= 0)
        ? '원격 응답이 없습니다'
        : '원격에 연결하지 못했습니다');
  }

  if (offline && cfg.offlinePolicy === 'block') {
    fail('원격을 볼 수 없어 발급을 멈췄습니다(' + offlineReason + '). ' +
         '다른 PC 가 어떤 번호를 잡았는지 알 수 없는 상태라 번호를 주지 않습니다. ' +
         'VPN 과 git 인증을 확인한 뒤 다시 부르세요. ' +
         '정말 끊긴 채로 받아야 하면 .task-id.json 에 {"offlinePolicy":"warn"} 을 두면 잠정 번호를 줍니다.',
         { offline: true });
  }

  // 원격 기준 브랜치에 커밋된 문서. 선점 ref 가 없는 번호(플러그인 이전 문서, 손으로 만든 문서)의
  // 최종 근거는 이것뿐이다. 못 보면 번호를 주지 않는다 - 겹칠 수 있는 번호를 주느니 멈춘다.
  let base = null;
  if (!offline) {
    base = committedPaths(cfg, cfg.remote, branchArgv, root);
    if (!base.ok) fail(base.error + ' 원격에 이미 커밋된 번호를 확인해야 해서 발급을 멈췄습니다.');
    for (const p of base.paths) {
      const n = numberAfter(path.basename(p), prefix);
      if (n >= 0) fromBase.push(n);
    }
  }

  const maxOf = arr => arr.reduce((m, x) => (x > m ? x : m), 0);
  let n = Math.max(maxOf(fromTree), maxOf(fromRefs), maxOf(fromBase)) + 1;

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true, dryRun: true, id: prefix + pad(n), domain: domain, year: year,
      max: { tree: maxOf(fromTree), refs: maxOf(fromRefs), branch: maxOf(fromBase) },
      scanned: { worktrees: worktrees.length, remote: !offline,
                 branch: base ? base.branch : null, branchFrom: base ? base.from : null },
      note: '미리보기라 선점하지 않았습니다. 실제로 받을 때 그 사이 다른 세션이 잡았으면 다음 번호가 나옵니다.',
    }));
    return;
  }

  const report = (id, attempts, extra) => {
    recordClaim(id, !!(extra && extra.offline));
    console.log(JSON.stringify(Object.assign({
      ok: true, id: id, attempts: attempts, domain: domain, year: year,
      path: slug ? cfg.taskDir + '/' + domain + '/' + id + '-' + slug + '.md' : null,
      scanned: { worktrees: worktrees.length, remote: !offline, branch: base ? base.branch : null },
    }, extra || {})));
  };

  if (offline) {
    return report(prefix + pad(n), 1, {
      offline: true,
      warning: '원격을 보지 못해 로컬과 형제 워크트리만으로 번호를 정했습니다(' + offlineReason +
               '). 이 번호는 잠정입니다 — 망이 살아나면 다시 확인하세요.',
    });
  }

  for (let i = 0; i < cfg.maxAttempts; i++, n++) {
    const id = prefix + pad(n);
    const ref = cfg.refNamespace + '/' + id;
    const msg = 'claim ' + id + ' pid=' + process.pid + ' t=' + Date.now() +
                ' r=' + Math.random().toString(36).slice(2) + '\n';
    const made = gitQuiet(['commit-tree', EMPTY_TREE], { input: msg });
    if (!made.ok) fail('선점용 객체를 만들지 못했습니다: ' + made.out.trim());
    const sha = made.out.trim();
    const push = gitQuiet(['push', '--force-with-lease=' + ref + ':', cfg.remote, sha + ':' + ref], { timeout: 15000 });
    if (push.ok) return report(id, i + 1);
    const why = push.out.toLowerCase();
    const taken = why.indexOf('rejected') >= 0 || why.indexOf('stale info') >= 0 ||
                  why.indexOf('already exists') >= 0 || why.indexOf('non-fast-forward') >= 0;
    if (!taken) {
      const lines = push.out.split('\n').filter(Boolean);
      fail('예약에 실패했습니다: ' + (lines.length ? lines[lines.length - 1].trim() : ''), { id: id });
    }
  }
  fail(cfg.maxAttempts + '번 시도했지만 번호를 잡지 못했습니다. 동시에 너무 많이 발급 중입니다.');
}

main();
