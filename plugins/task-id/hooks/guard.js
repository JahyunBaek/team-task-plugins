#!/usr/bin/env node
'use strict';
/**
 * 안전망 — 새로 만들어진 작업 기록 파일을 본다. 막지 않고 경고만 한다.
 *
 * 발급은 /task-new 가 한다. 이 훅은 그걸 거치지 않았거나, 거쳤어도 어긋난 경우를 알린다.
 *   1. 폴더 이름과 번호의 도메인이 다르다
 *   2. 같은 번호의 다른 문서가 이미 있다 (이 트리 · 형제 워크트리)
 *   3. /task-new 로 받은 번호가 아니다 - 원격에 이미 등록된 번호면 다른 세션·PC 의 번호라고 알린다.
 *      단 원격 ref 를 만든 사람이 지금 git 사용자면 「발급이 실패로 보고됐던 내 번호일 수 있다 — --adopt」 로,
 *      「확인 대기」 로 기록된 번호가 원격에 이 PC 가 민 그대로 있으면 알리지 않는다(0.2.2)
 *
 * 원격은 브랜치 대신 ref(번호 등록부)를 본다. 작업 기록은 대부분 기능 브랜치에서 만들어져서
 * 브랜치 하나만 봐서는 겹친 것을 못 찾는다.
 * 저장소가 이미 아는 파일(옛 문서 수정)은 건드리지 않는다.
 * 경고는 JSON(additionalContext · systemMessage)으로 낸다 - 종료 코드 0 의 표준 출력은 Claude 에게 가지 않는다.
 * 출력은 짧게 둔다. 경고도 대화 문맥에 쌓인다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { refOwner } = require(path.join(__dirname, '..', 'scripts', 'ref-owner.js'));

const DEFAULTS = { taskDir: 'docs/tasks', remote: 'origin', refNamespace: 'refs/task-ids' };

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

/**
 * 이 저장소에서 발급·등록한 번호. 워크트리끼리 함께 쓰는 자리와, 예전에 쓰던 워크트리별 자리를 함께 본다.
 * { ids, pending } — 「확인 대기」(발급이 실패로 끝났는데 원격에 잡혔을 수 있는 번호)는 ids 에 넣지 않고
 * pending[id] = 그때 민 객체 로 따로 둔다. 원격 ref 가 그 객체면 이 PC 의 번호다(0.2.2).
 */
function claimedIds(cwd) {
  const ids = [];
  const pending = {};
  for (const flag of ['--git-common-dir', '--git-dir']) {
    const dir = gitTry(['rev-parse', flag], cwd);
    if (!dir) continue;
    try {
      const list = JSON.parse(fs.readFileSync(path.resolve(cwd, dir.trim(), 'task-id-claims.json'), 'utf8'));
      if (!Array.isArray(list)) continue;
      for (const x of list) {
        if (!x || !x.id) continue;
        if (x.pending) { if (x.sha) pending[x.id] = x.sha; } else ids.push(x.id);
      }
    } catch (e) { /* 기록이 없다 */ }
  }
  return { ids: ids, pending: pending };
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

/** 이 PC 의 작업 트리와 형제 워크트리에서 같은 번호를 쓰는 다른 문서의 이름들. */
function sameNumberElsewhere(info, stem, root, cfg) {
  const prefix = info.id + '-';
  const found = new Set();
  for (const r of worktreeRoots(root)) {
    try {
      for (const f of fs.readdirSync(path.join(r, cfg.taskDir, info.domain))) {
        const s = f.replace(/\.md$/, '');
        if (s !== stem && (s === info.id || s.indexOf(prefix) === 0)) found.add(s);
      }
    } catch (e) { /* 그 트리에는 이 도메인 폴더가 없다 */ }
  }
  return [...found].sort();
}

/**
 * 원격 번호 등록부에 이 번호가 있나 - ref 가 있거나 바닥 표시 아래면 있다.
 * { registered, sha(그 번호 ref 의 객체, 바닥 표시로만 걸리면 null) }. 원격에 못 닿으면 null.
 * 훅이 작업을 막아선 안 되니 짧게 묻고 넘어간다.
 */
function remoteLookup(info, root, cfg) {
  const ns = cfg.refNamespace.replace(/\/+$/, '');
  const head = 'TASK-' + info.year + '-' + info.domain + '-';
  const out = gitTry(['ls-remote', cfg.remote, ns + '/' + info.id, ns + '/_floor/' + head + '*'], root, 5000);
  if (out === null) return null;
  const num = parseInt(info.num, 10);
  let registered = false;
  let sha = null;
  for (const line of out.split('\n')) {
    const at = line.indexOf('\t');
    if (at < 0) continue;
    const name = line.slice(at + 1).trim();
    if (name === ns + '/' + info.id) { registered = true; sha = line.slice(0, at).trim(); continue; }
    const n = parseInt(name.slice(name.lastIndexOf('-') + 1), 10);
    if (!isNaN(n) && num <= n) registered = true;
  }
  return { registered: registered, sha: sha, ref: ns + '/' + info.id };
}

function main() {
  const payload = readPayload();
  const file = payload && payload.tool_input && payload.tool_input.file_path;
  if (!file) return;

  const info = parseName(path.basename(String(file)));
  if (!info) return;

  const cwd = payload.cwd || process.cwd();
  const abs = path.resolve(cwd, String(file));

  // 저장소는 세션 폴더가 아니라 파일 위치로 찾는다. 세션은 주 저장소에 있고 파일은 워크트리
  // (.claude/worktrees/...) 안이거나, 다른 저장소의 파일을 고칠 때 세션 폴더로 찾으면 경로가
  // 작업 기록 폴더로 시작하지 않아 조용히 통과했다.
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const top = gitTry(['rev-parse', '--show-toplevel'], dir);
  if (!top) return;
  const root = path.resolve(top.trim());
  if (alreadyTracked(abs, root)) return;

  const cfg = Object.assign({}, DEFAULTS);
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(root, '.task-id.json'), 'utf8'))); }
  catch (e) { /* 설정 파일이 없으면 기본값 */ }

  // 작업 기록 폴더 밖이면 판단하지 않는다.
  const rel = path.relative(root, abs).split(path.sep).join('/');
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
  const claims = claimedIds(root);
  if (dupes.length) {
    const shown = dupes.slice(0, 2).join(', ') + (dupes.length > 2 ? ' 외 ' + (dupes.length - 2) + '건' : '');
    msgs.push('[task-id] ' + info.id + ' 는 이미 있습니다 - ' + shown + '\n' +
              '          번호를 /task-new 로 다시 받으세요.');
  } else if (claims.ids.indexOf(info.id) < 0) {
    const look = remoteLookup(info, root, cfg);
    if (look && look.sha && claims.pending[info.id] === look.sha) {
      // 「확인 대기」 로 남았던 번호가 원격에 이 PC 가 민 그대로 있다 — 이 PC 의 번호다
    } else if (look && look.registered) {
      const owner = look.sha ? refOwner(cfg.remote, look.ref, look.sha, root, 5000) : null;
      if (owner && owner.mine) {
        msgs.push('[task-id] ' + info.id + ' 는 이 PC 의 git 사용자(' + owner.email + ')가 원격에 잡은 번호인데 이 PC 발급 기록에는 없습니다.\n' +
                  '          발급이 실패로 보고됐지만 실제로는 잡혔던 번호일 수 있습니다. 이 번호를 쓸 거면 /task-new --adopt ' + info.id + ' 로 기록에 올리세요.');
      } else {
        msgs.push('[task-id] ' + info.id + ' 는 원격에 이미 등록된 번호입니다.\n' +
                  '          다른 세션이나 PC 가 받은 번호일 수 있습니다. 번호를 /task-new 로 다시 받으세요.');
      }
    } else {
      msgs.push('[task-id] ' + info.id + ' 를 선점하지 않고 새 작업 기록을 만들었습니다.\n' +
                '          목록을 보고 고른 번호라면 다른 세션이 같은 번호를 쓰고 있을 수 있습니다.\n' +
                '          번호는 /task-new 로 받으세요.');
    }
  }

  if (msgs.length) {
    // PostToolUse 훅이 종료 코드 0 으로 낸 표준 출력은 디버그 로그에만 남는다 - Claude 도 사람도 못 본다.
    // 그래서 JSON 으로 낸다. additionalContext 는 도구 결과 옆에서 Claude 가 보고, systemMessage 는 화면에 뜬다.
    const text = msgs.join('\n');
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
      systemMessage: text,
    }));
  }
}

main();
process.exit(0);
