'use strict';
/**
 * 기준 브랜치 판정 - 발급(claim)·정리(prune)·안전망(guard)이 함께 쓴다.
 *
 * "이미 쓰인 번호"의 최종 근거는 기준 브랜치에 커밋된 작업 기록 파일이다.
 * 선점 ref 는 커밋되기 전의 틈만 막는다. 그래서 셋 다 같은 브랜치를 봐야 한다.
 *
 * 코드커밋은 HEAD 의 symref 를 알려주지 않는다(깃허브는 알려준다). 그래서 여러 경로로 찾는다.
 * 못 찾으면 null 을 돌려준다 - 엉뚱한 브랜치를 보느니 멈추는 게 낫다.
 *
 * 일하는 브랜치가 기본 브랜치와 다르면(예: main 은 배포용, 실제 작업은 dev)
 * .task-id.json 에 defaultBranch 로 못박는 게 맞다.
 */
const { execFileSync } = require('child_process');

function gitQuiet(args, opts) {
  opts = opts || {};
  try {
    return {
      ok: true,
      out: execFileSync('git', args, {
        encoding: 'utf8',
        cwd: opts.cwd,
        timeout: opts.timeout || 20000,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      }),
    };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '') };
  }
}

function arg(argv, name, dflt) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : dflt;
}

/**
 * { branch: 'refs/heads/..', from: '어떻게 정했나' } 또는 { branch: null, error }
 * timeout 은 원격에 묻는 한 번당 상한이다. 훅처럼 오래 기다리면 안 되는 곳은 짧게 준다.
 */
function resolveBranch(cfg, remote, argv, cwd, timeout) {
  argv = argv || [];
  const asRef = b => (b.indexOf('refs/') === 0 ? b : 'refs/heads/' + b);

  const given = arg(argv, '--branch', null);
  if (given) return { branch: asRef(given), from: '--branch 인자' };
  if (cfg.defaultBranch) return { branch: asRef(cfg.defaultBranch), from: '.task-id.json 의 defaultBranch' };

  const sym = gitQuiet(['ls-remote', '--symref', remote, 'HEAD'], { cwd: cwd, timeout: timeout });
  if (sym.ok) {
    for (const line of sym.out.split('\n')) {
      if (line.indexOf('ref:') === 0) {
        const t = line.slice(4).trim().split(/\s+/)[0];
        if (t) return { branch: t, from: '원격이 알려준 HEAD' };
      }
    }
  }

  const head = 'refs/remotes/' + remote + '/';
  const local = gitQuiet(['symbolic-ref', head + 'HEAD'], { cwd: cwd });
  if (local.ok) {
    const t = local.out.trim();
    if (t.indexOf(head) === 0) {
      return { branch: 'refs/heads/' + t.slice(head.length), from: '로컬에 적힌 ' + remote + '/HEAD' };
    }
  }

  // 원격 HEAD 해시와 똑같은 브랜치가 딱 하나면 그것으로 본다.
  const h = gitQuiet(['ls-remote', remote, 'HEAD'], { cwd: cwd, timeout: timeout });
  const heads = gitQuiet(['ls-remote', '--heads', remote], { cwd: cwd, timeout: timeout });
  if (h.ok && heads.ok) {
    const sha = (h.out.split('\n')[0] || '').split('\t')[0].trim();
    const hit = [];
    for (const line of heads.out.split('\n')) {
      const at = line.indexOf('\t');
      if (at < 0) continue;
      if (line.slice(0, at).trim() === sha) hit.push(line.slice(at + 1).trim());
    }
    if (hit.length === 1) return { branch: hit[0], from: 'HEAD 해시와 일치하는 브랜치' };
  }

  return {
    branch: null,
    error: '어느 브랜치를 기준으로 삼을지 정하지 못했습니다. ' +
           '.task-id.json 에 defaultBranch 를 적어 주세요. 예: {"defaultBranch":"refs/heads/dev"} ' +
           '(코드커밋은 기본 브랜치를 알려주지 않습니다.)',
  };
}

/**
 * 원격 기준 브랜치의 끝 커밋에 들어 있는 작업 기록 파일 경로 목록.
 * { ok, paths, branch, from, sha } 또는 { ok: false, error }
 *
 * 추적 브랜치(refs/remotes/...)와 FETCH_HEAD 는 건드리지 않는다. 여러 세션이 동시에
 * 발급할 때 그 둘의 잠금에서 부딪힌다 - 실측으로 dev 를 움직이며 6개씩 동시에 5번(30회)
 * 발급했을 때 21회가 'cannot lock ref refs/remotes/origin/dev' 로 실패했다.
 * 그래서 끝 커밋의 해시를 먼저 묻고, 그 커밋이 없을 때만 객체를 가져와 해시로 직접 읽는다.
 */
function committedPaths(cfg, remote, argv, cwd, timeout) {
  timeout = timeout || 60000;
  const picked = resolveBranch(cfg, remote, argv, cwd, timeout);
  if (!picked.branch) return { ok: false, error: picked.error };
  const lastLine = s => s.trim().split('\n').filter(Boolean).pop() || '';

  const ls = gitQuiet(['ls-remote', remote, picked.branch], { cwd: cwd, timeout: timeout });
  if (!ls.ok) return { ok: false, error: '기준 브랜치(' + picked.branch + ')를 묻지 못했습니다: ' + lastLine(ls.out) };
  let sha = null;
  for (const line of ls.out.split('\n')) {
    const at = line.indexOf('\t');
    if (at > 0 && line.slice(at + 1).trim() === picked.branch) { sha = line.slice(0, at).trim(); break; }
  }
  if (!sha) return { ok: false, error: '원격에 기준 브랜치(' + picked.branch + ')가 없습니다.' };

  if (!gitQuiet(['cat-file', '-e', sha + '^{commit}'], { cwd: cwd }).ok) {
    const f = gitQuiet(['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', remote, picked.branch],
                       { cwd: cwd, timeout: timeout });
    if (!f.ok) return { ok: false, error: '기준 브랜치(' + picked.branch + ')를 가져오지 못했습니다: ' + lastLine(f.out) };
  }

  const t = gitQuiet(['ls-tree', '-r', '--name-only', sha, '--', cfg.taskDir], { cwd: cwd, timeout: 60000 });
  if (!t.ok) return { ok: false, error: '기준 브랜치의 파일 목록을 읽지 못했습니다: ' + lastLine(t.out) };
  return {
    ok: true,
    paths: t.out.split('\n').map(s => s.trim()).filter(Boolean),
    branch: picked.branch,
    from: picked.from,
    sha: sha,
  };
}

module.exports = { resolveBranch, committedPaths, arg };
