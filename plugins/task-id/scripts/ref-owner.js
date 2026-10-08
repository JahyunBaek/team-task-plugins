'use strict';
/**
 * 원격 선점 ref 를 누가 만들었나 - 발급(claim --adopt)과 안전망(guard)이 함께 쓴다.
 *
 * 발급이 "실패"로 끝났는데 원격에는 ref 가 생기는 일이 있다(push 시간 초과 · 응답만 끊김).
 * 그러면 그 번호는 이 PC 의 발급 기록(task-id-claims.json)에 없어서, 나중에 그 번호로 문서를 만들면
 * 「다른 세션이 받은 번호」 로 보인다. ref 가 가리키는 커밋의 작성자가 지금 git 사용자와 같으면
 * 다른 사람의 번호가 아니라 이 사용자가 잡은 번호다.
 *
 * 그 커밋 하나만 가져온다(빈 트리 위 123바이트). 추적 브랜치와 FETCH_HEAD 는 쓰지 않는다 -
 * 여러 세션이 동시에 부르면 그 둘의 잠금에서 부딪힌다(branch.js 의 실측).
 */
const { execFileSync } = require('child_process');

function gitTry(args, cwd, timeout) {
  try {
    return execFileSync('git', args,
      { encoding: 'utf8', cwd: cwd, timeout: timeout || 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return null;
  }
}

/**
 * ref(sha)를 만든 커밋의 작성자 메일이 이 저장소의 user.email 과 같은가.
 * 같으면 { mine: true, email }, 다르면 { mine: false, email, author }, 못 알아내면 null.
 */
function refOwner(remote, ref, sha, cwd, timeout) {
  if (!gitTry(['cat-file', '-e', sha + '^{commit}'], cwd)) {
    if (gitTry(['fetch', '--quiet', '--no-write-fetch-head', remote, ref], cwd, timeout) === null) return null;
  }
  const author = gitTry(['log', '-1', '--format=%ae', sha], cwd);
  const me = gitTry(['config', 'user.email'], cwd);
  if (!author || !me) return null;
  const a = author.trim().toLowerCase();
  const m = me.trim().toLowerCase();
  return a === m ? { mine: true, email: m } : { mine: false, email: m, author: a };
}

module.exports = { refOwner };
