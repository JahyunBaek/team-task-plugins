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
 * 원격을 못 보면 경고를 남기고 로컬 기준으로 발급한다(잠정).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULTS = {
  taskDir: 'docs/tasks',
  refNamespace: 'refs/task-ids',
  remote: 'origin',
  digits: 4,
  offlinePolicy: 'block',
  maxAttempts: 25,
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

/** 발급한 번호를 저장소에 적어 둔다. 훅이 이 목록을 보고 예약 없는 파일을 잡는다. */
function recordClaim(id, provisional) {
  const g = gitQuiet(['rev-parse', '--git-dir']);
  if (!g.ok) return;
  const file = path.join(g.out.trim(), 'task-id-claims.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  list.push({ id: id, at: new Date().toISOString(), provisional: !!provisional });
  try { fs.writeFileSync(file, JSON.stringify(list, null, 2)); } catch (e) { /* 기록 실패가 발급을 막지는 않는다 */ }
}

function main() {
  const argv = process.argv.slice(2);
  const domain = argv[0];
  if (!domain) fail('도메인을 지정하세요. 예: /task-new core 번호-발급');
  const slug = argv.slice(1).join(' ').split(' ').filter(Boolean).join('-');

  const rootRes = gitQuiet(['rev-parse', '--show-toplevel']);
  if (!rootRes.ok) fail('git 저장소가 아닙니다.');
  const root = rootRes.out.trim();

  const cfg = Object.assign({}, DEFAULTS);
  const cfgFile = path.join(root, '.task-id.json');
  if (fs.existsSync(cfgFile)) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); }
    catch (e) { fail('.task-id.json 을 읽지 못했습니다: ' + e.message); }
  }

  const year = new Date().getFullYear();
  const prefix = 'TASK-' + year + '-' + domain + '-';
  const pad = n => String(n).padStart(cfg.digits, '0');

  const used = [];
  const scan = base => {
    const d = path.join(base, cfg.taskDir);
    if (fs.existsSync(d)) for (const n of numbersInTree(d, prefix)) used.push(n);
  };
  scan(root);
  const worktrees = siblingWorktrees(root);
  for (const w of worktrees) scan(w);

  let offline = false;
  let offlineReason = '';
  const ls = gitQuiet(['ls-remote', cfg.remote, cfg.refNamespace + '/' + prefix + '*'], { timeout: 10000 });
  if (ls.ok) {
    for (const line of ls.out.split('\n')) {
      const at = line.indexOf(prefix);
      if (at < 0) continue;
      const n = numberAfter(line.slice(at), prefix);
      if (n >= 0) used.push(n);
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

  let n = 0;
  for (const u of used) if (u > n) n = u;
  n += 1;

  const report = (id, attempts, extra) => {
    recordClaim(id, !!(extra && extra.offline));
    console.log(JSON.stringify(Object.assign({
      ok: true, id: id, attempts: attempts, domain: domain, year: year,
      path: slug ? cfg.taskDir + '/' + domain + '/' + id + '-' + slug + '.md' : null,
      scanned: { worktrees: worktrees.length, remote: !offline },
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
