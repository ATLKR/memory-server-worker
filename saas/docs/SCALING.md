# Memory의 D1 10GB 제한과 확장 경로

확인일: 2026-09-08. 공식 Cloudflare 문서와 현재 `saas/` 소스의 읽기 전용 검토이며, 구현·배포·계정 한도 변경은 하지 않았다.

**서비스 전체가 10GB에서 멈출 필요는 없다. 다만 D1 데이터베이스 한 개의 10GB 제한은 상향할 수 없다.** 여러 DB에 데이터를 나누고, 오래된 본문은 R2로 옮기는 방식이 가능하다. 이는 물리적 한도와 비용이 있는 수평 확장이며, 무제한 저장을 보장한다는 뜻은 아니다. [D1 공식 한도](https://developers.cloudflare.com/d1/platform/limits/)

## 확인한 플랫폼 한도

| 항목 | Workers Paid 기준 | 상향 또는 설계상의 의미 |
| --- | --- | --- |
| D1 한 개 | 10GB | 공식 문서에서 상향 불가 명시. Free는 500MB |
| 계정당 D1 수 | 50,000개 | Paid/Enterprise는 상향 요청 가능. Free는 10개 |
| 계정의 D1 총 저장량 | 1TB | Paid/Enterprise는 상향 요청 가능. DB 수 한도와 별개 |
| Worker의 D1 바인딩 | 약 5,000개 | 실제 제약은 스크립트 메타데이터 1MB. 다른 바인딩·변수·시크릿도 소비 |
| D1 실행 | 동시 연결 6개, SQL 최대 30초 | 샤드 전체를 한 번에 조회하는 방식은 피하고 병렬 수·작업량 제한 |
| 단일 D1 처리 | 쿼리를 순서대로 처리 | 데이터 용량보다 먼저 지연·과부하가 병목이 될 수 있음 |

위 수치와 상향 가능 여부의 근거는 [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)이다. 읽기 복제는 읽기 처리량·지연을 위한 기능이며, 한 DB의 저장 한도를 합산해서 늘리는 기능은 아니다. [D1 읽기 복제](https://developers.cloudflare.com/d1/best-practices/read-replication/)

요청 한도에는 공식 문서 간 차이가 있다. D1 표에는 Paid 호출당 1,000쿼리라고 남아 있으나, 최신 Workers 문서와 2026-02-11 변경 공지는 Cloudflare 서비스 호출을 포함해 기본 10,000 subrequests, 설정으로 최대 1,000만을 명시한다. 이 검토만으로 D1 전용 제한도 없어졌다고 단정하지 않는다. 실제 확장 전 검증하며, 제품은 수십 개 이하의 제한된 샤드 조회를 목표로 한다. [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/), [공식 변경 공지](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)

Paid 일반 Worker 수는 계정당 500개이며, 문서는 더 큰 규모에 Workers for Platforms를 안내한다. 따라서 고객마다 Worker를 무조건 하나씩 만드는 설계보다 샤드 묶음에 Worker를 배정하는 편이 적합하다. [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)

## 현재 코드가 분할에 요구하는 것

- `saas/src/memory.ts:62`의 권한 SQL은 `spaces`, `active_credentials`, `active_memberships`를 함께 확인한다. 읽기는 primary에서 시작하고, 변경은 같은 SQL 안에서 현재 권한을 다시 검사한다. 현재 `MemoryService`는 DB 하나를 받는다.
- `saas/product-schema.sql:6`은 `(issuer, subject)`를 안정적인 계정 ID에 연결한다. 세션·이메일·멤버십·API 키의 관계 및 회수 처리는 중앙 관리 대상이다. 서비스 이름·도메인·조직 위치가 바뀌어도 이 식별자는 바꾸면 안 된다.
- `saas/memory-schema.sql:4`부터 Space·Memory·이력·감사 기록이 계정, 조직, credential을 같은 DB의 외래 키로 참조한다. `:100`의 트리거는 수정 전 본문 전체를 이력에 복사한다. 이력은 현재 수정·삭제가 금지된다.
- `saas/src/memory.ts:262` 검색은 현재 본문에 `instr(lower(body), lower(query))`를 적용한다. 전문검색 인덱스가 아니며, 본문을 R2로 옮기는 것만으로 현재 검색이 유지되지는 않는다.

따라서 DB 바인딩만 추가해서는 분할이 끝나지 않는다. D1의 `batch()`는 한 데이터베이스의 SQL 트랜잭션이며, 중앙 DB와 다른 DB/R2를 묶는 원자적 커밋 보장으로 해석할 수 없다. 분산 외래 키와 여러 저장소 사이의 일관성은 별도 설계가 필요하다. [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

## 권장 구조 — 조직 트리와 저장 위치를 분리

다음은 공식 제품 기능 설명이 아니라 현재 코드에 대한 설계 제안이다.

```text
Browser / MCP
     │
Memory API — 중앙 권한 확인
     ├─ Identity/Registry DB
     │    issuer+subject → account
     │    email / organization hierarchy / explicit memberships / credentials
     │    space_directory: space_id → shard_id + placement_epoch
     └─ Space storage router
          ├─ D1 shard A: 여러 작은 Space의 현재 본문·인덱스·감사 메타데이터
          ├─ D1 shard B: 큰 Space 또는 별도 배치된 Space
          └─ R2: 오래된 revision 본문·향후 큰 첨부 자료
```

**안정적인 `space_id`를 저장 배치의 기준으로 삼는다.** 작은 Space들은 같은 샤드 풀을 사용하고, 커지는 Space만 별도 샤드로 이동한다. 임의 깊이 조직 계층은 중앙 관계이며, 선택된 정책대로 ACL을 상속하지 않는다. 같은 루트 조직 아래의 하위 조직들을 한 DB에 묶지 않는다. 조직을 이동하거나 이름을 바꿔도 Space 데이터 이동을 요구하지 않는 구조다.

Space 하나가 커지면 그 내부도 `memory_id`의 해시 구간 등으로 나누고 디렉터리에 파티션을 기록할 수 있다. “조직당 DB 하나” 또는 “Space당 DB 하나”만으로는 단일 대형 고객의 10GB 한도가 없어지지 않는다. 검색·목록에는 여러 파티션 결과를 합치는 커서와 작업량 제한이 필요하다.

중앙 Identity DB 역시 유한하다. 초기에는 본문·이력을 분리하는 효과가 크지만, 중앙 계정·credential·감사 기록의 용량과 쓰기 부하도 계측해야 한다. 장기적으로 중앙 레지스트리의 분할이나 더 큰 관계형 DB로의 이전 선택지를 남긴다.

## 권한 회수를 약화시키지 않는 조건

현재의 같은 SQL 권한 확인을 “중앙에서 한 번 검사한 뒤 샤드에 쓰기”로 단순 교체하면 검사와 커밋 사이의 회수 경쟁이 생긴다. TTL 기반 ACL 캐시나 짧은 내부 토큰만으로 즉시 회수를 보장한다고 설명하면 안 된다.

분리 시에는 Space·작업·계정·credential·권한 세대에 한정된 내부 권한 증명을 사용하고, 회수와 진행 중 작업을 조정하는 프로토콜을 먼저 확정해야 한다. 예를 들어 회수 완료 응답 전에 관련 샤드에서 이전 세대 작업 차단 및 진행 중 작업 정리를 확인하는 barrier를 둘 수 있다. 장애 시 완료를 잘못 보고하거나 오래된 권한으로 우회하지 않도록 한다. 이 프로토콜은 아직 구현된 보장이 아니며, 동시 회수·쓰기·재시도·샤드 장애 테스트가 선행되어야 한다. 조직 상속이 없으므로 관련 범위도 실제 멤버십과 Space 기준으로 계산한다.

## R2는 오래된 이력부터 적용

R2 공식 한도에서 버킷 저장량과 객체 수는 Unlimited이다. 그러나 객체 크기·요청·요금 등의 제약은 남는다. [R2 Limits](https://developers.cloudflare.com/r2/platform/limits/)

현재 본문은 건당 최대 16KiB이므로, 첫 후보는 계속 쌓이는 **이전 revision의 본문**이다. 현재 본문과 검색용 데이터는 D1에 두면 기존 검색과 단일 DB 변경 경로를 오래 유지할 수 있다. 이력 원문을 불변 R2 객체에 저장하고 D1에는 hash·객체 키·revision·감사 메타데이터를 남기는 방식을 검토한다. 기존 append-only 트리거를 유지한 채 즉석 삭제하는 변경이 아니라, 보존 정책과 검증된 archive 절차를 가진 정식 마이그레이션이 필요하다.

R2의 객체 쓰기·삭제는 강한 일관성을 제공하지만, 이것이 D1 변경까지 원자적으로 묶지는 않는다. D1 outbox → 불변 객체 업로드 → 무결성 검증 → 보관 완료 표시 → 승인된 보존 절차 순서로 처리하고 재시도·고아 객체 청소를 설계한다. [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

현재 본문까지 R2에 옮길 때는 별도 검색 인덱스가 필요하다. R2 기본 API의 목록 조회는 키·prefix 중심이며 본문 부분문자열 검색을 대신하지 않는다. D1에 검색용 전체 텍스트를 그대로 복제하면 그 텍스트는 계속 D1 용량을 차지한다. 인덱스 종류, 갱신 지연, 삭제 반영, 결과별 최신 권한 확인을 함께 설계해야 한다. [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions)

R2 SQL도 존재하지만 현재는 R2 Data Catalog의 Apache Iceberg 테이블을 조회하는 분석용 open beta이다. 일반 R2 객체의 현재 검색 API를 그대로 대체하는 기능으로 간주하지 않는다. [R2 SQL](https://developers.cloudflare.com/r2-sql/)

## 다음 구현 범위 제안

1. DB 총량, 현재 본문/이력/인덱스/감사 기록의 비중, 증가율, 쿼리 지연·읽은 행 수를 계측한다. 6–7GB부터 이동을 준비하는 운영 기준은 예시이며 실제 증가 속도에 맞춰 정한다.
2. 우선 기존 DB를 `shard-0`으로 표현하는 저장 인터페이스와 `space_directory` 계약을 설계한다. 이 단계는 물리적 분할이나 보안 모델 변경을 요구하지 않는다.
3. 오래된 이력의 R2 보관 설계를 별도 작은 변경으로 검증한다. 현재 검색 동작은 유지하고, 복구·무결성·삭제/보존 정책을 테스트한다.
4. 실제 Space 분할은 회수 프로토콜 검증 후 진행한다. 작은 단위 복사·검증, 쓰기 차단/정리, placement epoch 전환, 되돌리기 절차를 갖추고 한 Space부터 이전한다. 전체 고객 데이터의 대규모 일괄 이동은 첫 단계로 삼지 않는다.

현 단계의 결정은 **“D1을 계속 사용하면서 Space별 분할 가능 구조를 준비하고, 이력부터 R2로 분리한다”**가 적합하다. 먼저 계측하면 실제 데이터 분포에 따라 샤딩을 해야 할 시점과 R2만으로 확보되는 여유를 판단할 수 있다.
