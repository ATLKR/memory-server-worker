# 조직 공통 동의 런타임

관리자 한 명이 고객사의 기존 동의와 적용 범위를 등록하면, 직원은 동일 동의를 반복 입력하지 않는다. 이 문서는 구현 및 운영 연결 상태를 설명하며 법률 판단을 대신하지 않는다.

## 연결된 기능

- `GET /v1/organizations/:org/medical-cloudflare-consent`: 현재 조직 관리자 세션으로 원장 조회.
- `PUT` 동일 경로: 최근 재인증한 관리자만 `expectedVersion`과 새 범위·기간·증빙 참조를 저장.
- `DELETE` 동일 경로: 정확한 `expectedVersion`으로 철회. 시작 전의 예약 동의도 철회할 수 있다.
- `POST /v1/routing/consent/check`: SSO 또는 PAT의 실제 Space 권한과 소속 조직을 확인한 뒤 불투명 일회용 receipt 발급. 원문은 받지 않는다.
- receipt를 첨부한 `/mcp`의 `memory_ingest`와 `memory_search`: 명시적으로 허용된 조직 의료 Space의 연결 경로. 전송 및 결과 공개 직전에 현재 권한과 동의를 재검증한다.

부모 조직의 관리자·멤버·동의가 자식 조직에 상속되지 않는다. 외부 공유만 받은 사람이나 개인 Space를 임의의 고객사 동의에 연결하지 않는다. 의료 프로필은 조직·Space·동의 ID의 해시로 분리한다. 철회 후 새 동의는 새 ID와 새 프로필을 사용하며, 이전 프로필의 실제 삭제를 완료했다는 뜻은 아니다.

## 저장 및 실패 처리

일반 경로와 함께 배포 단위 `AgentMemoryBudgetLedger`를 필수로 검사하도록 확장했다. 의료 경로도 최초 동의 작업 승인 후 예산을 예약하고, 전송·공개 직전 만료와 권한을 검사한다. `x-memory-routing: 1`을 사용하는 새 클라이언트의 동의 사전 확인은 의료 provider 활성화·Space 허용·예산 설정까지 검증한다. 관리자 동의 관리와 기존 receipt-only 점검 API는 provider 활성화와 독립적이다. [일반 경로 문서](general-runtime.ko.md)에 예산과 출시 제한이 정리돼 있다.

`OrganizationConsentLedger`는 조직마다 별도의 SQLite Durable Object를 사용한다. 동의의 현재 버전, 수정 불가능한 감사 이력, receipt 해시, 작업 ID·본문 해시·결과 상태를 저장한다. 원문, 검색어, 토큰, 증빙 문서는 이 원장에 넣지 않는다.

한 동의 수정은 버전 CAS, receipt 소비와 작업 예약은 동기 SQL 트랜잭션으로 처리한다. receipt는 최대 60초이며 원장과 권한의 더 짧은 만료 시각을 따른다. 동일 작업 ID로 다른 본문을 보내면 충돌 처리한다. 제공자 결과가 불명확한 쓰기는 다시 보내지 않으며, 실패한 검색은 `read_failed`로 기록한다. 프로세스가 중단되어 `admitted`로 남은 작업도 전송 허가로 재사용하지 않는다.

한 계정의 미사용 receipt 100개, 조직 전체 receipt 10,000개, 조직의 월 작업 10,000개를 제한한다. 이 수량 제한은 Cloudflare 요금의 USD 50 상한을 보증하는 금액 제한이 아니다. 제공자의 실제 과금·전체 사용량 수집과 연결해야 한다.

현재 인증·Space 권한은 기존 D1에서 읽는다. D1과 DO 사이의 조회·변경은 단일 트랜잭션이 아니다. 전체 권한 저장소 전환 및 철회 경합의 운영 검증 전에는 D1 제거 완료나 GA 완료로 표시하지 않는다.

## 운영자 설정

스테이징 설정에 `MEMORY_CONSENT_LEDGER` SQLite DO 바인딩 및 최초 마이그레이션이 있다. 의료 원문 전송은 `MEMORY_ROUTING_ENABLED=false`가 기본이다. 원장 관리자 기능과 제공자 연결 여부는 별개다.

제공자 연결 후보를 켤 때 필요한 설정은 다음과 같다.

- `MEMORY_ROUTING_ENABLED=true`
- `MEMORY_AGENT_MEMORY_ACCOUNT_ID`: 운영자 소유 Cloudflare 계정
- `MEMORY_AGENT_MEMORY_NAMESPACE`: 검증한 전용 네임스페이스
- `MEMORY_AGENT_MEMORY_TOKEN`: 해당 계정의 제한된 서비스 토큰을 secret으로 설정
- `MEMORY_ROUTING_MEDICAL_SPACES_JSON`: 검증할 조직 Space ID 목록
- `MEMORY_AGENT_MEMORY_BUDGET` 바인딩, `MEMORY_ROUTING_BUDGET_ID`, `MEMORY_ROUTING_BUDGET_POLICY_JSON`: 배포 공통 예산 원장과 검증한 예약 정책
- `MEMORY_ROUTING_SEOUL_SPACES_JSON`: 서버에서 강제로 서울 경로를 유지할 Space ID 목록

설정은 에이전트 도구 인수에서 변경할 수 없다. 서울 강제 목록, `requiredRegion:kr-seoul`, `region-locked`, `uncertain`은 의료 동의보다 우선한다. 베타 접근이나 제공자 동작을 확인하지 않은 상태에서 기본 비활성을 해제하지 않는다.

현재 배포 설정은 기존 운영 D1/R2/Vectorize 서비스와 호환하는 스테이징 후보다. 일반 Agent Memory 경로는 연결됐으며 기본 비활성이다. 서울 PostgreSQL 실행 환경, 전체 권한 저장소의 D1 제거, 제공자 삭제·복구, 실제 비용 검증, 최종 readiness는 후속 출시 조건이다.

## 검증

`npm run test:routing-runtime`은 실제 SQLite DO의 재시작·동시성·만료·CAS와 기존 인증·관리자 화면·MCP를 검증한다. 전체 결합 테스트는 실제 workerd/D1/DO를 사용하고 HTTP 제공자는 합성 응답으로 격리한다. `npm run check`에 포함되어 있다. 이 테스트를 Cloudflare Agent Memory 실계정의 ingest·검색 성공으로 해석하지 않는다.
