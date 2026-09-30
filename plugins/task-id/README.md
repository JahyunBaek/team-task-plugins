# task-id

작업 기록 번호를 **조회가 아니라 발급**으로 받는다.

## 무엇을 막는가

목록을 훑어 빈 번호를 고르는 방식에는 조회와 쓰기 사이에 틈이 있다. 두 세션이 같은 찰나에 같은 번호를 고르면 둘 다 통과한다. 워크트리를 갈라 병렬로 일하면 옆 세션이 아직 커밋하지 않은 파일은 아예 보이지 않는다. 다른 PC라면 더 그렇다.

이 플러그인은 번호를 고른 뒤 **원격에 그 이름으로 표식을 만든다.** "없을 때만 만들기"로 밀기 때문에 같은 번호를 동시에 노린 세션 중 하나만 성공하고, 나머지는 거절받아 다음 번호로 넘어간다. 판정을 원격이 하므로 다른 PC까지 덮인다.

표식은 `refs/task-ids/<번호>` 에 쌓인다. 작업 폴더나 브랜치는 건드리지 않는다.

## 설치

```bash
claude plugin marketplace add https://github.com/JahyunBaek/team-task-plugins
claude plugin install task-id@team-task-plugins
```

## 쓰는 법

```
/task-new <도메인> <이름>
```

발급된 번호로만 파일을 만든다. 결과의 `attempts` 가 2 이상이면 그 사이 다른 세션이 번호를 채갔다는 뜻이다.

```json
{"ok":true,"id":"TASK-2026-core-0042","attempts":2,"path":"docs/tasks/core/TASK-2026-core-0042-...md"}
```

## 설정

저장소 루트에 `.task-id.json` 을 두면 바뀐다.

| 키 | 기본값 | 뜻 |
|---|---|---|
| `taskDir` | `docs/tasks` | 작업 기록이 쌓이는 폴더 |
| `refNamespace` | `refs/task-ids` | 예약 표식을 두는 이름공간 |
| `remote` | `origin` | 판정을 맡길 원격 |
| `digits` | `4` | 번호 자릿수 |
| `offlinePolicy` | `warn` | 원격을 못 볼 때 — `warn`(경고 후 진행) 또는 `block`(중단) |
| `maxAttempts` | `25` | 거절당했을 때 다음 번호로 넘어가는 최대 횟수 |

## 구성

| 조각 | 하는 일 |
|---|---|
| `/task-new` 커맨드 | 번호를 예약하고 발급한다 |
| `guard` 훅 (PostToolUse) | 예약을 거치지 않은 파일을 잡는다. 막지 않고 경고만 한다 |
| `task-id` 스킬 | 규칙과, 거절·망 끊김 때의 행동 |

## 맞바꿈

- 발급할 때마다 원격을 한 번 탄다. 끊겨 있으면 경고를 남기고 로컬 기준으로 **잠정** 발급한다.
- 예약해 놓고 문서를 쓰지 않으면 그 번호는 빈다.
- 예약 표식이 쌓인다. 주기적으로 정리할 방법이 필요하다.

## 요구 사항

- git (`--force-with-lease` 를 쓰므로 2.20 이상 권장)
- node
