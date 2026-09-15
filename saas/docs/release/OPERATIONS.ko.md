# 운영·복구

## 원본과 파생 데이터

D1의 현재 기억·revision 이력이 원본이다. FTS와 Vectorize는 파생 인덱스다. Vectorize에는 원문을 넣지 않고 memory ID/revision과 벡터만 넣는다. 검색된 후보의 내용·권한은 다시 D1에서 확인한다. 벡터 자체도 민감한 파생 데이터로 취급하며 별도 접근 제어와 삭제 정책이 필요하다.

거절/충돌/권한 회수 후 재시도는 현재 SQL 권한으로 판단한다. background job은 originating credential의 현재 권한을 확인한다. 기한이 지난 브라우저 session으로 제출한 ingest는 실행 시 권한 만료로 실패할 수 있다. 장기 수집에는 용도와 유효기간이 제한된 create 전용 key를 쓰고 결과 열람은 별도 read 권한으로 한다. 원문만 있으면 제멋대로 권한을 우회해 재실행하지 않는다.

## 큐

`release_jobs`는 pending/leased/done/dead 상태와 attempt, lease_token, lease_until을 가진다. 120초 lease와 fencing으로 늦은 worker가 현재 결과를 덮어쓰지 않게 한다. 실패 5회 후 dead로 가며 `/manage`에서 허용된 운영자가 재시도할 수 있다. 인덱스 재구축은 현재 revision별로 작업을 다시 만들고 실행 중 lease를 강제로 초기화하지 않는다.

매분 기본 작업 처리량은 제한되어 있다. lexical 검색은 트랜잭션 시점에 갱신되지만 semantic 반영은 지연될 수 있다. backlog와 oldest age를 실제 유입량에 맞춰 경보 대상으로 삼고 필요하면 소비량이나 큐 아키텍처를 변경한다. 무제한 처리량이나 정해진 복구 시간을 약속하지 않는다.

결제는 별도 DB lock과 유한량 consumer를 사용한다. webhook payload의 상태를 곧바로 적용하지 않고 공급자 현재 subscription을 조회한다. 이미 연결된 subscription은 주기적 재조회로 webhook 누락을 보완한다. 최초 subscription 생성 webhook 자체가 유실되어 아직 pool에 연결되지 않은 경우까지 자동 탐색하지는 않는다. 공급자 쪽 event replay와 checkout reconciliation 운영 절차가 필요하다. retry 한도를 넘긴 결제 이벤트는 운영자가 원인 해결 후 명시적으로 재처리해야 한다.

## 삭제와 보존

기억 삭제는 tombstone이며 기본 30일 휴지통 정책이다. 복원은 보존 기간 안에서 revision 검사를 통과해야 한다. 명시적 영구 제거는 최근 본인 확인과 정확한 ID 입력을 요구한다. 기억 본문/source/provenance/eventTime과 이전 본문 버전을 지우고, 식별자 중심 erasure ledger로 벡터 정리를 추적한다. 남은 ID, 계정 관계, 작업 fingerprint, 감사 식별자가 개인정보와 완전히 무관하다고 주장하지 않는다.

벡터 삭제 요청이 수락됐다는 사실과 조회에서 실제 사라진 것은 구분한다. 확인되지 않으면 재시도하며 늦은 upsert가 되살아나는 경우에도 다시 정리한다. cron 중단/공급자 장애가 있으면 물리 제거가 지연될 수 있다. 이미 내보낸 다운로드 파일이나 사용자의 별도 복사본을 이 서비스에서 회수할 수는 없다.

임시 대화 원문은 서버 관리 키로 AES-GCM 암호화되고 AAD에 작업 ID를 사용한다. 승인/취소 때 즉시 제거하고, 미처리 원문은 24시간 만료 후 유지보수에서 정리한다. 만료 제안은 API에서 숨기므로 정리 지연이 열람 허용 기간을 늘리지 않는다. 키에 버전별 복호화 keyring은 없으므로 회전 전에 해당 키로 암호화된 작업을 처리하거나 취소해야 한다. keyring 기반 무중단 key rotation은 추가 작업이다.

**백업 안의 과거 본문, 계정/이메일/결제 전체 개인정보는 이 개별 기억 제거 API의 완료 범위가 아니다.** 전역 탈퇴·삭제 정책을 별도로 확정하고 구현해야 한다.

## 복구 훈련

출시 전에 다음 순서를 staging에서 실제 수행한다.

1. 원본 D1 snapshot/export, 현재 schema 버전, 권한 회수/erasure ledger의 독립 복사본, 적용 코드 hash를 기록한다. 백업 접근 권한과 암호화를 별도로 관리한다.
2. 새 격리 DB에 복구한다. 외부 트래픽은 닫고 모든 이전 key/session을 유효한 것으로 가정하지 않는다.
3. snapshot 이후 발생한 계정/이메일/멤버십 회수와 영구 제거를 재적용한다. 이를 재구성할 자료가 없으면 복구본을 사용자에게 노출하지 않는다.
4. 새 인덱스로 canonical 데이터에서 재구축하고 제거된 기억·다른 tenant 결과가 안 나오는지 검사한다. 오래된 인덱스만 연결해서 복구하지 않는다.
5. 개수·revision·삭제·공유·권한·검색 샘플과 현재 provider 상태를 확인하고 승인 후 승격한다. 결과와 실패를 기록한다.

자동 외부 백업 생성기나 원본 전체 restore orchestrator는 이 ZIP에 구현되어 있지 않다. 이 문서는 실행 절차이며 실제 복구 성공 기록이 아니다.

## 외부 회수 이벤트 계약

`POST /webhooks/identity`, raw UTF-8 JSON. 헤더:

```
x-memory-timestamp: UNIX_SECONDS
x-memory-signature: lowercase_hex(HMAC_SHA256(secret, timestamp + "." + raw_body))
```

시간 허용 오차는 300초, event ID는 고유해야 한다. 같은 ID/같은 raw body 재전송은 허용하고 다른 body는 충돌이다. raw body를 서명 후 재직렬화하지 않는다. secret은 최소 32문자이며 충분한 난수로 만든다.

```json
{"id":"event-unique-id","issuer":"https://auth-api.allen.company","subject":"provider-subject","type":"email.revoked","email":"person@example.com"}
```

계정 비활성화는 `type=account.disabled`이다. email 회수는 해당 계정의 서비스 claim을 회수하며 메일 공급자의 mailbox를 삭제하는 API가 아니다. 조직 SCIM 회수는 해당 멤버십을 회수하고 개인 계정을 삭제하지 않는다. 발행 측에서는 durable event 기록, 실패 재전송, 누락 재조정, 관리자 회수 시험이 필요하다. 수신기가 생겼다고 외부 이벤트가 자동 발행되는 것은 아니다.

## 관측성

선택적 Analytics Engine에는 제한된 route 분류, 메서드, HTTP 상태, 지연과 개수만 보낸다. URL query, OAuth code, body, 이메일, token, account ID는 넣지 않는다. 원본 request/invocation logging은 비활성 상태를 유지한다. 원문을 알 수 없는 상태 코드 집계만으로 모든 장애가 설명되지는 않으므로 승인된 진단 절차를 따로 정한다.

권장 운영 점검은 `/ready` heartbeat, queue pending/dead/oldest, provider 오류율, pool storage, quota 거절, 장기 미정리 erasure, billing pending/dead, 도메인 검증 만료다. 실제 pager/alert destination 자동 연결은 완료하지 않았다.
