# API 계약과 호환성

## 인증과 권한

기존 중앙 OAuth 서명 검증·PKCE·audience/issuer 검증을 바꾸지 않았다. browser session과 외부 OAuth bearer는 구분하며, bearer가 계정관리 session으로 승격되지 않는다. 계정 관리에는 interactive session, 민감한 변경에는 5분 이내 메일 proof 재인증이 필요하다. 토큰 사용이나 재발급만으로 reauthenticated_at을 새로 쓰지 않는다.

API 키 capability는 `read`, `create`, `update`, `delete`, `export`이며 선택적으로 `spaceIds`를 제한한다. 기본 capability가 없으면 새 API 경로는 read로 제한한다. 조직 쓰기는 현재 owner/admin 조건을 유지한다. 조직 계층은 자동 권한 상속이 아니다. 외부 OAuth의 `memory:write`는 create/update만 의미하며 delete/export를 자동 추가하지 않는다. 원본 인증기는 `memory:read`를 요구하므로 OAuth append-only 전용 토큰까지 지원한다고 주장하지 않는다. append-only는 API 키에서 사용할 수 있다.

## 멱등성과 결과

REST 메모리 쓰기는 `Idempotency-Key` 헤더 또는 JSON `operationId`를 사용한다. 둘 다 있으면 같아야 한다. MCP 쓰기 도구에서는 `operationId`가 필수다. REST에서 키를 생략하면 새 작업으로 취급되므로 응답 유실 재시도 중복 방지를 보장하지 않는다. 요청을 보내기 전에 클라이언트가 작업 키를 보관해야 한다.

동일 계정/Space/작업 키와 같은 의미의 입력은 한 번만 적용하고 사용량도 한 번 기록한다. 동일 키·다른 내용은 409. 작업 결과가 이미 있어도 현재 권한을 다시 검사한다. 수정/삭제/복원/제거에는 `expectedRevision`이 필요하다. 읽기 권한 없는 create/update 키에는 저장된 본문 대신 다음과 같은 receipt만 반환한다.

```json
{"id":"memory-id","spaceId":"space-id","revision":1,"committedRevision":1,"replayed":false,"representation":"receipt"}
```

이 키는 저장 성공 확인용이지 기억 조회용이 아니다. 삭제/승인 등의 모든 API를 포괄하는 무제한 전역 exactly-once 보장은 하지 않는다. 명시된 memory operation/ingest/checkout에 적용되는 계약이다.

## 주요 REST 경로

`S`는 Space ID, `M`은 memory ID, `J`는 ingest ID다. 브라우저 state-changing 요청은 기존 Origin/CSRF 검사를 통과해야 한다.

| 경로 | 메서드·입력 |
|---|---|
| `/v1/spaces` | GET `limit,cursor`; POST는 원본 Space 생성 코드 |
| `/v1/spaces/S/memories` | POST `body,source?,kind?,provenance?,eventTime?,supersedesMemoryId?,operationId?`; GET `query` 또는 `limit,cursor,deleted` |
| `/v1/spaces/S/memories/M` | GET; PATCH `body,source?,expectedRevision,operationId?`; DELETE `expectedRevision,operationId?` |
| `/v1/spaces/S/memories/M/restore` | POST `expectedRevision,operationId?` |
| `/v1/spaces/S/memories/M/erase` | POST `expectedRevision,confirmation=M,operationId?`; 최근 재인증 필요 |
| `/v1/spaces/S/retention` | PUT `days` 1–3650, 기본 휴지통 30일 |
| `/v1/spaces/S/exports` | POST snapshot session; GET `/exports/ID?cursor=...` |
| `/v1/spaces/S/ingests` | POST `messages,operationId?`; GET 본인 작업 목록 |
| `/v1/spaces/S/ingests/J` | GET 제안; DELETE 취소/원문 제거 |
| `/v1/spaces/S/ingests/J/approve` | POST `selected` index 배열, `operationId?` |
| `/v1/spaces/S/shares` | POST `email,days`; DELETE `/shares/ID` |
| `/v1/shares` | GET 수신 invitation; POST `/v1/shares/ID/accept` |
| `/v1/spaces/S/usage` | GET 공동 pool의 논리 사용량 |
| `/v1/spaces/S/billing/checkout` | POST `priceId,operationId?` |
| `/v1/spaces/S/billing/portal` | POST |
| `/v1/spaces/S/index/rebuild` | POST, 현재 revision outbox 재생성 |
| `/v1/spaces/S/jobs` | GET; POST `/jobs/ID/retry` 실패 작업 재시도 |
| `/v1/keys` | POST `label,capabilities,spaceIds?,organizationId?,expiresInDays`; DELETE `/v1/keys/ID`는 기존 회수 경로 |
| `/v1/account/reauth` | POST `emailId`; POST `/reauth/complete`에 `challengeId,proof` |
| `/v1/account/emails` | GET/POST `email`; POST `/emails/verify`에 `challengeId,proof`; DELETE `/emails/ID` |
| `/v1/organizations/O/domains` | POST `domain`; POST `/v1/domains/verify`에 `challengeId` |
| `/v1/domains/D/delegates` | POST `membershipId`; `/v1/domains/D/emails/revoke` POST `email` |
| `/v1/organizations/O/scim-keys` | POST 발급; DELETE `/scim-keys/ID` 회수 |

원본의 조직/멤버십/초대 경로는 그대로 남는다. 목록마다 pagination이 동일한 것은 아니다. Space와 memory/export는 커서를 지원하고, ingest/job 운영 목록은 제한된 개수다. 장기 기록 전체 조회 UI로 오해하지 않는다.

## MCP

`/mcp`에서 stateless JSON-RPC POST를 제공한다. 지원 대상으로 명시한 프로토콜은 2025-06-18 및 2025-11-25이다. 최신 모든 MCP 사양과 클라이언트를 검증한 것은 아니다. 도구는 `memory_spaces`, `memory_search`, `memory_get`, `memory_list`, `memory_add`, `memory_update`, `memory_delete`, `memory_ingest`다. GET streaming/session resumption은 구현하지 않았다. 실제 클라이언트 호환성은 staging에서 확인한다.

기존 개인용 endpoint와 인수가 다르다. URL만 교체하지 말고 tool 목록과 Space 선택을 다시 구성한다. 기존 에이전트가 기억 내용을 지시문으로 실행하지 않도록 도구 결과를 데이터로 취급해야 한다.

## 수치와 과금 의미

본문은 UTF-8 16,384 bytes, source는 2,048 bytes 이하다. 대화 추출은 최대 100개 메시지, 개별 8,000 bytes, 전체 canonical JSON 24,000 bytes, 제안 최대 20개다. 임시 원문 유효기간은 24시간이다. 물리적 정리는 cron이 수행하고, 만료된 제안은 cron 지연 중에도 조회에서 숨긴다.

product units는 실제 토큰과 다르다. 저장/수정/검색 등 성공한 동작은 코드에 정의된 단위, ingest 제출은 100 단위, 승인 저장은 선택한 개수만큼을 소모한다. 무료 기본값은 월 1,000 units/본문+이력 논리량 100 MiB이다. 운영 가격 제안이나 수익성 검증 결과가 아닌 초기 코드 기본값이다. UTC 달력 월과 결제 공급자의 청구 주기가 같다는 보장도 없다. 과금 설명과 공급자 청구 모델은 출시 전에 정합시켜야 한다.

storageBytes는 현재/이전 memory 본문·source·provenance의 논리량이다. 인덱스, audit/operation ledger, 임시 encrypted ingest 등 DB 전체 물리 크기나 Cloudflare 청구량이 아니다.
