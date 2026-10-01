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
const { committedPaths, arg } = require('./branch.js');

const DEFAULTS = {
  taskDir: 'docs/tasks',
  refNamespace: 'refs/task-ids',
  remote: 'origin',
  pruneKeep: 20,
  defaultBranch: null,
  digits: 4,
};
const BATCH = 100;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FLOOR = '_floor';

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
  const floorHead = head + FLOOR + '/';
  const refs = [];
  const floors = new Map();   // key -> { num, ref }
  let bytes = 0;
  for (const line of ls.out.split('\n')) {
    if (!line.trim()) continue;
    bytes += line.length + 1;
    const at = line.indexOf('\t');
    if (at < 0) continue;
    const name = line.slice(at + 1).trim();
    if (name.indexOf(floorHead) === 0) {
      const f = parseId(name.slice(floorHead.length));
      if (f) {
        const cur = floors.get(f.key);
        if (!cur || f.num > cur.num) floors.set(f.key, { num: f.num, ref: name });
      }
      continue;
    }
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

  // 2. 기준 브랜치에 커밋된 작업 기록 파일
  const base = committedPaths(cfg, remote, argv, root, 180000);
  if (!base.ok) fail(base.error);
  const branch = base.branch;
  const picked = { from: base.from };

  const committed = new Set();
  const maxCommitted = new Map();
  for (const p of base.paths) {
    const info = parseFileName(path.basename(p));
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
      kept.push({ id: r.id, reason: '작업 기록 파일이 아직 기준 브랜치에 없습니다' });
    } else if (r.info.num > top - keep) {
      kept.push({ id: r.id, reason: '최근 ' + keep + '개 여유분입니다 (최대 ' + top + ')' });
    } else {
      deletable.push(r);
    }
  }

  const summary = {
    ok: true, remote: remote, branch: branch, branchFrom: picked.from, keep: keep,
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

  // 4. 바닥 표시를 먼저 세운다.
  //
  // ref 를 지우면 그 번호가 쓰였다는 근거가 원격에서 사라진다. 뒤처진 체크아웃은
  // 자기 파일 목록만 보고 번호를 정하므로, 이미 쓰인 번호를 다시 받을 수 있다.
  // 그래서 그룹마다 "여기까지는 이미 쓰였다"를 ref 이름에 적어 하나 남긴다.
  // 발급 쪽은 이 번호도 함께 보고 그 위에서 시작한다.
  //
  // 순서가 중요하다. 세우기 전에 지우면 그 사이가 빈다.
  const failures = [];
  const groups = new Map();
  for (const r of deletable) {
    if (!groups.has(r.info.key)) groups.set(r.info.key, []);
    groups.get(r.info.key).push(r);
  }

  const pad = n => String(n).padStart(cfg.digits, '0');
  const floorsSet = [];
  const ready = [];
  for (const [key, list] of groups.entries()) {
    const [year, domain] = key.split('/');
    const top = maxCommitted.get(key);
    const was = floors.has(key) ? floors.get(key).num : -1;
    const want = Math.max(top, was);
    const name = head + FLOOR + '/TASK-' + year + '-' + domain + '-' + pad(want);

    if (want > was) {
      const made = gitQuiet(['commit-tree', EMPTY_TREE],
        { input: 'floor TASK-' + year + '-' + domain + ' <= ' + pad(want) + '\n' });
      if (!made.ok) { failures.push(key + ': 바닥 표시 객체를 만들지 못했습니다'); continue; }
      const put = gitQuiet(['push', '--force', remote, made.out.trim() + ':' + name], { timeout: 60000 });
      if (!put.ok) {
        failures.push(key + ': 바닥 표시를 세우지 못해 지우지 않았습니다 - ' +
                      (put.out.trim().split('\n').filter(Boolean).pop() || ''));
        continue;
      }
      floorsSet.push({ group: key, floor: want, was: was < 0 ? null : was });
    }
    ready.push({ key: key, list: list, oldFloor: (was >= 0 && want > was) ? floors.get(key).ref : null });
  }

  // 5. 삭제 - 한 번에 BATCH 개씩. git 은 한 push 안의 ref 를 각각 원자적으로 처리한다.
  let deleted = 0;
  const doomed = [];
  for (const g of ready) {
    for (const r of g.list) doomed.push(r.ref);
    if (g.oldFloor) doomed.push(g.oldFloor);
  }
  for (let i = 0; i < doomed.length; i += BATCH) {
    const chunk = doomed.slice(i, i + BATCH);
    const res = gitQuiet(['push', remote, '--delete'].concat(chunk), { timeout: 180000 });
    if (res.ok) deleted += chunk.length;
    else failures.push(res.out.trim().split('\n').filter(Boolean).pop() || '알 수 없는 오류');
  }
  summary.deleted = deleted;
  summary.floorsSet = floorsSet;
  if (failures.length) summary.failures = failures.slice(0, 3);
  console.log(JSON.stringify(summary));
}

main();
