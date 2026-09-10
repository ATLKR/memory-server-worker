# API 계약과 호환성

현재 rc.4 source는 schema 21과 PR 전용 migrations 8–21을 요구한다. 마지막 배포 기록은 rc.3와 migrations 1–7이다. 현재 전체 로컬 검증은 1,410개 테스트를 통과했다. Native 검증의 소스 범위와 남은 실환경 수락 조건은 [통합 기록](INTEGRATION.md), 적용 순서는 [migration 목록](DEPLOYMENT.ko.md)을 확인한다.

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

조직·Space 생성 POST는 멱등 요청이 아니다. 응답 유실로 성공 여부가 불확실하면 `/v1/workspace`를 새로 조회하고 기존 ID·이름·조직 및 부모 조직을 확인한 뒤 필요한 경우에만 다시 생성한다. 같은 POST를 자동 재전송하지 않는다.

도메인 위임 POST는 동일한 domain ID와 membership ID의 유효한 기존 위임이면 `200 {"completed":true}`를 반환한다. 재시도마다 현재 도메인 관리자·대상 멤버십·도메인 유효기간과 브라우저 session의 최근 메일 proof를 검사한다. 회수된 위임은 재활성화하지 않으며, 재가입한 멤버십으로 기존 위임을 다시 연결하지 않는다.

`POST /v1/domains/verify`는 `challengeId`를 받아 `id,name,verifiedUntil`을 반환한다. 0020_domain-verification-schema.sql의 단일 receipt/trigger 문장이 DNS challenge 소비, 도메인 생성·갱신, 정확한 관리자 멤버십 연결을 함께 적용하거나 롤백한다. 완료 receipt가 있는 같은 challenge ID 재조회에는 동일 계정의 현재 브라우저 session·5분 이내 proof·원래의 유효 owner/admin 멤버십·회수되지 않은 관리자 연결과 도메인/receipt 유효기간이 필요하다. 다른 현재 session이라도 이 조건을 만족하면 원래 결과를 반환한다. DNS를 다시 조회하거나 `verifiedUntil`을 연장하지 않으며, 만료·권한 회수 후에는 `403 domain_challenge_unavailable` 등 현재 권한 오류를 반환한다.

수락된 공급자 `email.revoked` 이벤트는 정확한 계정·주소의 미사용 pending proof를 무효화한다. 해당 차단이 남아 있으면 새 proof 발급·소비도 403으로 거절한다. 0020 backfill은 기존 차단과 일치하며 아직 사용·무효화되지 않은 proof만 DB 실행 시각으로 무효화한다. 0021_domain-retention-schema.sql의 선택적 만료 인덱스로 정리하는 DNS challenge는 만료된 미사용 행에 한정하며 한 번에 최대 100개다. 소비된 DNS proof와 변경 불가 검증 receipt는 보존한다.

관리 콘솔은 편집 응답이 자신의 제출 초안만 정리하도록 한다. 늦은 응답은 최신 실패 초안을 지우지 않으며, 본문 없는 receipt의 제출본은 별도로 보존한다. 확인된 공유 회수 역시 이전 목록 응답으로 되돌리지 않고, 새 조회가 반환한 시각만 기록 시각으로 표시한다.

## 주요 REST 경로

`S`는 Space ID, `M`은 memory ID, `J`는 ingest ID다. 브라우저 state-changing 요청은 기존 Origin/CSRF 검사를 통과해야 한다.

두 브라우저 콘솔은 변경 요청에 현재 표시 중인 계정 ID를 `X-Memory-Account-Id`로 보낸다. 서버는 그 요청에서 검증한 credential의 계정과 비교하며 다르면 실행 전에 `409 account_mismatch`를 반환한다. 다른 탭에서 로그인 계정을 바꾼 경우 이전 초안을 새 계정 명의로 제출하지 않도록 하는 장치다. 이 헤더는 인증 수단이 아니며 기존 REST/PAT/MCP 클라이언트에는 선택 사항이지만, 보내면 일치해야 한다.

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
| `/v1/spaces/S/shares` | GET 발급 이력: `limit` 기본 25, 최대 100, `cursor`; 응답 `results,nextCursor`. POST `email,days`; DELETE `/shares/ID` |
| `/v1/shares` | GET 수신 invitation: `limit` 기본 25, 최대 100, `cursor`; 응답 `results,nextCursor`. cursor는 수신 계정에 귀속. POST `/v1/shares/ID/accept` |
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

원본의 조직/멤버십/초대 경로는 그대로 남는다. 목록마다 pagination이 동일한 것은 아니다. Space와 memory/export, 공유 발급 이력과 수신 invitation은 커서를 지원하고, ingest/job 운영 목록은 제한된 개수다. 장기 기록 전체 조회 UI로 오해하지 않는다.

휴지통 행의 `restoreUntil`은 `deletedAt + 현재 Space retentionDays × 86400000`이며, `restoreExpired`는 응답 시각이 그 기한 이상인지 나타낸다. 기본 정책은 30일이고 정책 변경은 다음 조회·복원 판단에 반영된다. 두 필드는 보존 기한 정보이며 update 권한을 뜻하지 않는다. 복원은 현재 update 권한과 `expectedRevision` 검사를 별도로 통과해야 한다. 일치하는 revision의 tombstone이 기한에 도달하면 `409 restore_expired`, revision이 맞지 않으면 `409 revision_conflict`다.

메모리 GET·목록·검색은 최종 primary snapshot에서 현재 read 권한과 반환할 revision의 제거 여부·요청한 live/휴지통 상태를 함께 검사한다. 일반 목록·검색은 후속 기억으로 대체된 항목도 제외한다. export는 과거 snapshot revision을 유지하되 최종 조회에서 현재 export 권한·export session과 원본의 영구 제거 여부를 검사한다. 이 최종 snapshot이 응답 판단 기준이다. 목록·export에서 뒤늦게 제외된 항목이 있어도 원시 페이지 기준 `nextCursor`는 유지하므로, `results`가 비어도 cursor가 있으면 다음 페이지를 조회한다.

ingest 상세·목록은 현재 권한과 작업 상태를 같은 최종 primary snapshot에서 읽고 반환 시 만료도 확인한다. `approved`·`cancelled` 상태는 만료 시각 뒤에도 그대로 표시하며, 그 외 만료 작업은 `expired`다. 제안과 인용문은 만료되지 않은 `review` 상태에서만 반환하고 승인·취소·만료 응답에는 이전 제안을 포함하지 않는다.

공유 발급 이력 GET은 현재 브라우저 session과 해당 Space의 현재 update 권한이 필요하다. PAT와 외부 OAuth bearer는 사용할 수 없으며, 목록 조회에는 최근 메일 proof가 필요하지 않다. cursor는 조회 계정과 Space에 귀속되며 `createdAt`, `id` 내림차순으로 다음 페이지를 읽는다. 각 행은 `id,spaceId,recipientEmail,createdAt,expiresAt,acceptedAt,revokedAt`을 반환한다. 이전 브라우저 session에서 만든 grant와 만료·회수된 이력도 포함한다. 이 시각들은 보존된 이력이며 현재 수신자의 접근 가능 여부를 보장하지 않는다.

공유 POST는 멱등 요청이 아니다. 응답 유실로 성공 여부가 불확실하면 자동 POST 재시도를 하지 말고 발급 목록을 새로 조회해 원본·중복 grant를 확인하고 원하지 않는 grant를 회수한다. 공유 발급과 기존 DELETE 회수에는 현재 update 권한과 5분 이내 메일 proof가 계속 필요하다.

검색은 UTF-8 1,024바이트 이내 원래 쿼리에서 서로 다른 검색어를 최대 20개 처리한다. 처리되는 각 접두어는 Unicode 문자 31자 이하여야 하며, 이를 넘으면 사용량 차감이나 외부 호출 전에 `400 search_token_too_long`을 반환한다. 지원 길이 모두에 접두어 인덱스를 사용하며, 선택한 Space 안의 일치 밀도로 순위를 정한다. 다른 고객의 문서 통계를 사용하는 전역 BM25 순위는 사용하지 않는다. 본문과 검색어는 같은 Unicode61 규칙을 사용하며 검색어만 NFKC로 변환하지 않는다. 전각 문자·합자를 동일한 글자로 검색할 수 있으며 ASCII 호환 변형과는 구분된다. 일반 부분문자열 검색을 제공한다는 의미는 아니다.

## MCP

`/mcp`에서 stateless JSON-RPC POST를 제공한다. 지원 대상으로 명시한 프로토콜은 2025-06-18 및 2025-11-25이다. 최신 모든 MCP 사양과 클라이언트를 검증한 것은 아니다. 도구는 `memory_spaces`, `memory_search`, `memory_get`, `memory_list`, `memory_add`, `memory_update`, `memory_delete`, `memory_ingest`다. GET streaming/session resumption은 구현하지 않았다. 실제 클라이언트 호환성은 staging에서 확인한다.

기존 개인용 endpoint와 인수가 다르다. URL만 교체하지 말고 tool 목록과 Space 선택을 다시 구성한다. 기존 에이전트가 기억 내용을 지시문으로 실행하지 않도록 도구 결과를 데이터로 취급해야 한다.

## 수치와 과금 의미

본문은 UTF-8 16,384 bytes, source는 2,048 bytes 이하다. 대화 추출은 최대 100개 메시지, 개별 8,000 bytes, 전체 canonical JSON 24,000 bytes, 제안 최대 20개다. 임시 원문 유효기간은 24시간이다. 물리적 정리는 cron이 수행하고, 만료된 제안은 cron 지연 중에도 조회에서 숨긴다.

product units는 실제 토큰과 다르다. 저장/수정/검색 등 성공한 동작은 코드에 정의된 단위, ingest 제출은 100 단위, 승인 저장은 선택한 개수만큼을 소모한다. 무료 기본값은 월 1,000 units/본문+이력 논리량 100 MiB이다. 운영 가격 제안이나 수익성 검증 결과가 아닌 초기 코드 기본값이다. UTC 달력 월과 결제 공급자의 청구 주기가 같다는 보장도 없다. 과금 설명과 공급자 청구 모델은 출시 전에 정합시켜야 한다.

storageBytes는 현재/이전 memory 본문·source·provenance의 논리량이다. 인덱스, audit/operation ledger, 임시 encrypted ingest 등 DB 전체 물리 크기나 Cloudflare 청구량이 아니다.
