# team-task-plugins

여러 세션이 한 저장소에서 함께 일할 때 생기는 충돌을 막는 Claude Code 플러그인 모음. **이 저장소 자체가 배포처(marketplace)다.**

## 설치

```bash
claude plugin marketplace add https://github.com/JahyunBaek/team-task-plugins
claude plugin install task-id@team-task-plugins
```

## 들어 있는 것

| 플러그인 | 하는 일 |
|---|---|
| [task-id](plugins/task-id) | 작업 기록 번호를 원격에 예약해서 발급한다. 여러 세션이 같은 번호를 동시에 잡을 수 없다 |

## 왜 만들었나

AI 세션을 여러 개 띄워 병렬로 일하면, 각 세션이 작업 기록 문서를 남긴다. 번호를 목록에서 골라 쓰면 **조회와 쓰기 사이의 틈** 때문에 같은 번호가 겹친다. 워크트리를 갈라 쓰면 옆 세션이 아직 커밋하지 않은 파일은 보이지도 않는다.

번호 네 개를 동시에 발급해 보면 차이가 분명하다.

| 방식 | 네 세션 동시 발급 결과 | 고유 번호 |
|---|---|---|
| 목록을 보고 고르기 | 넷 다 같은 번호 | 1 / 4 |
| 원격에 예약하기 | 서로 다른 네 번호 | 4 / 4 |
