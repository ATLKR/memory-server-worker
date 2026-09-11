# 일반 Agent Memory 런타임

일반 메모리의 REST·MCP 경로가 같은 실행기를 사용한다. 개인 Space와 조직 Space를 지원하고, 기존 SSO/PAT의 정확한 Space·동작 권한을 전송과 결과 공개 직전에 다시 검사한다. 부모 조직 관계는 접근 권한을 주지 않는다. 허용된 외부 공유는 읽기만 가능하다.

## API와 플러그인

REST 경로는 `/v1/spaces/:spaceId/agent-memory/` 아래에 있다. `POST ingest`는 `{routing,operationId,messages,sessionId?}`, `POST search`는 `{routing,query,limit?}`를 받는다. `GET usage`는 해당 Space의 이번 UTC 월 사용량을 반환한다. `POST clear`에는 `{routing,operationId,scope:"all-general-memory-in-space"}`가 필요하다. POST 본문에서 URL의 Space를 바꿀 수 없다.

MCP 도구는 `memory_ingest`, `memory_search`, `memory_usage`, `memory_clear_space`이다. 새 프로토콜 요청에는 `x-memory-routing: 1`을 붙인다. 플러그인이 이를 자동으로 처리하며 기존 MCP 호출과 구분한다. clear는 다른 구성원이 저장한 내용을 포함한 해당 Space의 **일반 Agent Memory 전체**를 숨기는 파괴적 작업이다. 의료 동의 프로필이나 기존 Memory API의 기록을 함께 지웠다는 뜻은 아니다.

표준 원격 MCP는 SDK의 stateless 초기화·도구 목록·알림·ping을 지원한다. 일반 도구를 호출하기 전 `memory_route_check`에 Space ID와 작업 종류만 보내 현재 경로를 확인한다. 플러그인은 동일 검사를 `POST /v1/spaces/:spaceId/agent-memory/check`로 자동 수행한다. 요청에는 `{version:1,requestId,operation}`만 넣고 원문·검색어는 보내지 않는다. 다른 Space 때문에 전역 discovery가 ready여도, 대상 Space의 서버 서울 잠금이나 권한 거절이 있으면 원문을 전송하지 않는다. 의료 정보는 일반 도구에 넣지 않고 지역 라우팅 플러그인의 동의 경로를 사용한다.

사전 확인 응답은 `issuedAtMs`, `expiresAtMs`와 정확한 요청·Space·작업을 묶는다. 플러그인은 서버의 최대 60초 유효기간을 요청 시작 시점의 단조 시계에 적용한다. 네트워크 왕복 시간도 차감되므로 PC와 서버 시계 차이로 유효기간이 늘어나지 않는다. 확인 결과는 영구 권한이 아니며 실제 실행 시 다시 검증한다. MCP 제어 통신은 [공식 수명주기](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)와 [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)를 기존 SDK로 처리한다.

`/.well-known/memory-routing`은 `memory-routing-v1` 프로토콜 가용성을 공개한다. `ready`는 초대 GA 통과나 지역 증명이 아니다. 원문 저장·검색은 ready가 false일 때 전송하지 않는다. 명시적인 clear·usage는 원문과 검색어가 없는 관리 요청이므로 같은 프로토콜·저장소·지역을 확인한 후 비활성 discovery에서도 시도할 수 있다. 서버의 현재 권한·설정 검증은 여전히 필요하다.

## 저장소와 계량

- `AgentMemorySpaceLedger`는 `space:<실제 Space ID>`마다 작업 해시, 주체 ID, 상태, 월별 수량, 프로필 세대와 삭제 outbox만 저장한다. 본문·검색어·답변·토큰은 넣지 않는다.
- 프로필은 실제 소유자 종류·ID, Space, Cloudflare 계정·namespace, 세대로 결정된다. 호출자별 프로필을 만들지 않아 조직 구성원과 허용된 공유 읽기가 같은 데이터에 접근한다.
- `AgentMemoryBudgetLedger`는 `budget:<배포 예산 ID>` 한 곳에서 일반·의료 Space의 예약을 합산한다. 동일 작업은 한 번만 예약하며, 결과가 불명확하거나 호출 전에 중단됐어도 예약을 환불하지 않는다.
- 월별 요청·UTF-8 입력 바이트·보수적 금액 예약을 원자적으로 제한한다. 월 정책은 고정되며 설정 가능한 예약 상한은 50,000,000 microUSD이다. `billingVerified:false`이고, 이 수치는 Cloudflare 전체 청구액이 아니다. 실제 계정 요금 범위·월 $50 경보 검증은 별도 출시 조건이다.

정책 필드는 `version:1`, `revision`, `validUntilMs`, `maxMonthlyRequests`, `maxMonthlyInputBytes`, `maxMonthlyReservedMicroUsd`, `ingestBaseMicroUsd`, `ingestMicroUsdPerKiB`, `searchBaseMicroUsd`, `searchMicroUsdPerKiB`, `pricingBasis:"operator-upper-bound"`이다. 키비바이트 단위는 올림하며 기본 요청 단가가 추가된다. 정책은 운영자가 검증한 상한 요율을 사용해야 한다. 저장·검색 admission에는 만료되지 않은 정책이 필요하고, clear·usage는 정상 형식의 정책이 만료되거나 사용 한도가 소진돼도 가능하다.

## 삭제와 실패

clear는 먼저 세대를 원자적으로 교체한다. 이전 세대의 검색 응답과 늦은 저장 결과가 다시 공개되지 않는다. 그 후 고정된 이전 프로필의 삭제를 요청한다. 같은 clear ID의 재생은 세대를 다시 늘리거나 공급자 삭제를 다시 실행하지 않는다.

`logicallyHidden`, `providerAcknowledged`, `cleanupPending`, `physicalPurgeVerified`를 구분한다. 공급자 ACK만으로 물리적 삭제를 보장하지 않으며 마지막 값은 항상 false이다. 삭제 outbox는 서버 전용 `reconcileGeneralRetirements`로 재시도할 수 있다. 클라이언트의 만료된 쓰기 권한을 다시 살리는 API는 없다.

재처리는 영구 순환 커서를 사용해 앞선 실패 항목 때문에 뒤의 삭제가 계속 대기하지 않게 한다. 취소된 요청은 아직 시도하지 않은 항목의 결과를 바꾸지 않으며, 한 건의 기록 오류가 다른 항목 처리를 막지 않는다. 공급자 삭제 응답 뒤 권한이 취소돼도 이미 관찰한 삭제·ACK 상태를 미전송으로 바꾸지 않는다. 예산 예약 응답이 유실된 경우에는 안정적인 예약 ID로 미전송 결과를 기록하되 재예약·환불은 하지 않는다.

진행 중인 이전 세대 ingest는 삭제 ACK 확정을 막는다. 프로세스 중단으로 영구 `admitted`가 남은 경우의 증거 기반 복구와, 공급자의 비동기 ingest 완료 이후 삭제 재조정은 아직 GA 조건이다. 이 상태를 시간 경과만으로 성공 처리하거나 재전송하지 않는다. 자동 스케줄러 연결, 의료 프로필의 동의 철회 후 삭제, 보존·복구 훈련도 후속 작업이다.

## 운영 연결과 남은 출시 조건

새 staging DO 바인딩은 `MEMORY_AGENT_MEMORY_SPACES`, `MEMORY_AGENT_MEMORY_BUDGET`이다. 일반 활성화는 `MEMORY_GENERAL_ROUTING_ENABLED`, 허용 목록은 `MEMORY_ROUTING_GENERAL_SPACES_JSON`이다. 예산은 `MEMORY_ROUTING_BUDGET_ID`와 `MEMORY_ROUTING_BUDGET_POLICY_JSON`으로 설정한다. 기존 공급자 계정·namespace·비밀 토큰 설정을 사용한다. `MEMORY_ROUTING_SEOUL_SPACES_JSON`은 일반·의료 허용 목록보다 우선한다.

기본 배포 설정은 일반·의료 provider 경로 모두 비활성이다. 기존 D1 신원/ACL은 여전히 사용하며, 새 원장이 생겼다고 D1 이전이 완료된 것은 아니다. 완전한 DO 권한 이전, Seoul PostgreSQL/pgvector 실제 런타임, 공급자 수명주기 복구, 임베딩 세대의 실제 backfill/cutover, 비용·경보·운영 수용 검증을 끝내야 GA로 승격할 수 있다. 운영 배포 증거는 소스 커밋과 별도 인수인계 기록에 보관한다.
