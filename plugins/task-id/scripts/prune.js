#!/usr/bin/env node
'use strict';
/**
 * 선점 ref 정리 - 쓸모를 다한 ref 를 원격에서 지운다.
 *
 * ref 는 "이 번호는 내가 잡았다"는 표시다. 그 번호의 작업 기록 파일이 원격 기본 브랜치에
 * 커밋된 순간부터, 번호는 파일 자체가 영구히 차지한다. 발급 때 번호를 정하는 기준이
 * 「파일에서 찾은 최대값」과 「ref 에서 찾은 최대값」 중 큰 쪽이므로, 파일이 있는 번호의
 * ref 를 지워도 다음 번호는 내려가지 않는다.
 *
 * 반대로 파일이 아직 원격에 없는 번호의 ref 를 지우면 그 번호가 다시 풀린다.
 * 다른 PC 에 아직 푸시하지 않은 초안이 있으면 같은 번호가 두 번 나간다.
 * 그래서 이 스크립트는 파일이 원격에 커밋된 번호만 지운다.
 *
 * 기본은 조회만 한다. 실제로 지우려면 --apply 를 준다.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  taskDir: 'docs/tasks',
  refNamespace: 'refs/task-ids',
  remote: 'origin',
  pruneKeep: 20,
};
const BATCH = 100;

function git(args, opts) {
  opts = opts || {};
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: opts.timeout || 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}
function gitQuiet(args, opts) {
  try { return { ok: true, out: git(args, opts) }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.stdout || e.message || '') }; }
}
function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

/** TASK-<연도>-<도메인>-<번호> 를 뜯는다. 아니면 null. */
function parseId(id) {
  if (id.indexOf('TASK-') !== 0) return null;
  const parts = id.split('-');
  if (parts.length < 4) return null;
  const year = parts[1];
  if (year.length !== 4 || isNaN(Number(year))) return null;
  const domain = parts.slice(2, parts.length - 1).join('-');
  const numTxt = parts[parts.length - 1];
  if (!numTxt.length || isNaN(Number(numTxt))) return null;
  return { year: year, domain: domain, num: parseInt(numTxt, 10), key: year + '/' + domain };
}

/** 파일 이름 앞머리에서 같은 꼴을 찾는다. 이름 뒤에 설명이 붙어 있어도 된다. */
function parseFileName(name) {
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
  const num = parseInt(parts[i].split('.')[0], 10);
  return { year: year, domain: dom.join('-'), num: num, key: year + '/' + dom.join('-') };
}

function arg(argv, name, dflt) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : dflt;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.indexOf('--apply') >= 0;

  const rootRes = gitQuiet(['rev-parse', '--show-toplevel']);
  if (!rootRes.ok) fail('git 저장소가 아닙니다.');
  const root = rootRes.out.trim();

  const cfg = Object.assign({}, DEFAULTS);
  const cfgFile = path.join(root, '.task-id.json');
  if (fs.existsSync(cfgFile)) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch (e) { /* 기본값으로 간다 */ }
  }
  const remote = arg(argv, '--remote', cfg.remote);
  const keep = Math.max(0, parseInt(arg(argv, '--keep', String(cfg.pruneKeep)), 10) || 0);
  const onlyDomain = arg(argv, '--domain', null);
  const onlyYear = arg(argv, '--year', null);

  // 1. 원격에 있는 선점 ref
  const ls = gitQuiet(['ls-remote', remote, cfg.refNamespace + '/*'], { timeout: 30000 });
  if (!ls.ok) fail('원격의 ref 목록을 보지 못했습니다: ' + ls.out.trim().split('\n').pop());
  const head = cfg.refNamespace + '/';
  const refs = [];
  let bytes = 0;
  for (const line of ls.out.split('\n')) {
    if (!line.trim()) continue;
    bytes += line.length + 1;
    const at = line.indexOf('\t');
    if (at < 0) continue;
    const name = line.slice(at + 1).trim();
    if (name.indexOf(head) !== 0) continue;
    const info = parseId(name.slice(head.length));
    if (!info) continue;
    if (onlyDomain && info.domain !== onlyDomain) continue;
    if (onlyYear && info.year !== onlyYear) continue;
    refs.push({ ref: name, id: name.slice(head.length), info: info });
  }
  if (!refs.length) {
    console.log(JSON.stringify({ ok: true, refs: 0, deletable: 0, deleted: 0,
      message: '정리할 선점 ref 가 없습니다.' }));
    return;
  }

  // 2. 원격 기본 브랜치에 커밋된 작업 기록 파일
  const sym = gitQuiet(['ls-remote', '--symref', remote, 'HEAD'], { timeout: 20000 });
  let branch = null;
  if (sym.ok) {
    for (const line of sym.out.split('\n')) {
      if (line.indexOf('ref:') === 0) { branch = line.split(/\s+/)[1]; break; }
    }
  }
  if (!branch) fail('원격의 기본 브랜치를 확인하지 못했습니다. 원격 접속과 권한을 확인하세요.');
  const fetched = gitQuiet(['fetch', '--quiet', remote, branch], { timeout: 120000 });
  if (!fetched.ok) fail('원격 기본 브랜치를 가져오지 못했습니다: ' + fetched.out.trim().split('\n').pop());
  const tree = gitQuiet(['ls-tree', '-r', '--name-only', 'FETCH_HEAD', '--', cfg.taskDir], { timeout: 60000 });
  if (!tree.ok) fail('원격 브랜치의 파일 목록을 읽지 못했습니다: ' + tree.out.trim().split('\n').pop());

  const committed = new Set();
  const maxCommitted = new Map();
  for (const p of tree.out.split('\n')) {
    if (!p.trim()) continue;
    const info = parseFileName(path.basename(p.trim()));
    if (!info) continue;
    committed.add(info.key + '#' + info.num);
    const cur = maxCommitted.get(info.key);
    if (cur === undefined || info.num > cur) maxCommitted.set(info.key, info.num);
  }

  // 3. 판정
  const deletable = [];
  const kept = [];
  for (const r of refs) {
    const k = r.info.key;
    const top = maxCommitted.has(k) ? maxCommitted.get(k) : -1;
    if (!committed.has(k + '#' + r.info.num)) {
      kept.push({ id: r.id, reason: '작업 기록 파일이 아직 원격에 없습니다' });
    } else if (r.info.num > top - keep) {
      kept.push({ id: r.id, reason: '최근 ' + keep + '개 여유분입니다 (최대 ' + top + ')' });
    } else {
      deletable.push(r);
    }
  }

  const summary = {
    ok: true, remote: remote, branch: branch, keep: keep,
    refs: refs.length, lsRemoteBytes: bytes,
    deletable: deletable.length, kept: kept.length,
    byDomain: [...maxCommitted.entries()].map(([k, v]) => ({ group: k, maxCommitted: v }))
      .sort((a, b) => a.group < b.group ? -1 : 1),
    sample: { deletable: deletable.slice(0, 5).map(r => r.id), kept: kept.slice(0, 5) },
  };

  if (!apply) {
    summary.deleted = 0;
    summary.note = '조회만 했습니다. 실제로 지우려면 --apply 를 주세요.';
    console.log(JSON.stringify(summary));
    return;
  }

  // 4. 삭제 - 한 번에 BATCH 개씩. git 은 한 push 안의 ref 를 각각 원자적으로 처리한다.
  let deleted = 0;
  const failures = [];
  for (let i = 0; i < deletable.length; i += BATCH) {
    const chunk = deletable.slice(i, i + BATCH);
    const res = gitQuiet(['push', remote, '--delete'].concat(chunk.map(r => r.ref)), { timeout: 120000 });
    if (res.ok) deleted += chunk.length;
    else failures.push(res.out.trim().split('\n').filter(Boolean).pop() || '알 수 없는 오류');
  }
  summary.deleted = deleted;
  if (failures.length) summary.failures = failures.slice(0, 3);
  console.log(JSON.stringify(summary));
}

main();
