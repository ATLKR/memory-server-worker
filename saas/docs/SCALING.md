# Memory의 물리 D1 샤딩과 R2 저장

2026-09-10 현재 소스는 **0.5.0-rc.1, 중앙 schema 25, HOT schema 1**이다. 물리 샤딩과 비공개 R2 payload 분리는 구현되어 있다. Staging의 이전 후보 `1a93820`은 중앙 1–23/HOT 1에서 같은 Space의 실제 쓰기를 두 HOT DB에 분산하고 R2 읽기를 검증했다. Production은 rc.3/중앙 1–7 그대로다. 중앙 24–25와 최신 수정은 아직 배포하지 않았다. 이 기록은 최종 후보의 GA 수락 완료가 아니다.

## 현재 저장 구조

```text
Browser / REST / MCP
        │
Memory Worker
        ├─ 중앙 D1: identity, 현재 ACL, Space, revision head/history pointer,
        │           논리 사용량, 작업 receipt, staging intent, 정리 outbox
        ├─ HOT D1 A/B/…: 불변 payload의 검색용 본문과 FTS
        └─ 비공개 R2: 현재·과거 payload의 canonical body/source/provenance
```

[MemoryStore](../src/release/memory.ts)는 중앙 변경을 담당하고 [PayloadStore](../src/release/payloads.ts)는 외부 저장·읽기를 담당한다. 중앙의 고정 pointer는 payload ID, shard ID, object key, SHA-256 및 canonical byte 수를 가진다. 논리 저장량은 별도 값이며 HOT 이력 정리나 inline 이관만으로 quota를 환급하지 않는다. 기존 inline 행은 호환 읽기를 유지한다.

먼저 중앙에 계정·Space·작업 ID와 요청 fingerprint에 귀속된 intent를 기록하고, 정해진 위치에 불변 payload를 준비한다. 중앙 SQL이 현재 권한·revision·quota·intent 상태를 검사해 pointer와 receipt를 원자적으로 발행한다. 실패한 외부 준비물은 발행되지 않으며 제한된 GC 대상이다. 같은 작업 ID/입력의 재시도는 기존 결과를 확인하므로 중복 과금이나 새 위치 선택을 피한다.

DB 사이에 ACL을 복제하거나 만료 시간만 있는 허가를 저장하지 않는다. 본문을 외부에서 읽은 뒤 중앙의 최종 primary snapshot이 현재 credential, 정확한 멤버십 또는 독립적으로 수락한 공유, 필요한 동작, revision과 제거 상태를 확인한다. 권한 기한은 마지막 조회 뒤에도 확인한다. 응답 판단 기준은 이 snapshot이며, 이미 전달된 응답을 회수한다는 의미는 아니다. 조직 부모·자식은 저장 위치나 ACL 상속 기준이 아니다.

## 샤드 등록과 확장

`STORAGE_MODE=sharded`, 비공개 `MEMORY_PAYLOADS` R2 binding, `STORAGE_SHARDS_JSON`이 필요하다. 레지스트리는 최대 16개의 정확한 `{id,binding,mode}` 항목을 허용하고 `mode`는 `active` 또는 `draining`이다. 최소 하나의 active가 필요하다. 모든 HOT DB에 [shard-migrations/0001_payloads.sql](../shard-migrations/0001_payloads.sql)을 적용한다.

새 payload는 Space ID와 새 payload ID로 active 샤드 중 위치를 정한다. 한 Space도 여러 물리 DB를 사용할 수 있다. 저장된 위치는 재시도·읽기에서 다시 계산하지 않는다. draining은 새 배치를 중단하지만 기존 pointer를 계속 읽고 검색·정리한다. **draining으로 바꿔도 기존 payload가 자동 이동하지 않는다.** 기존 pointer를 가진 binding을 지우거나 shard ID를 다른 DB에 연결하면 안 된다.

검색은 inline 및 등록된 HOT의 제한된 후보를 모으고 중앙의 현재 head를 확인한 뒤 순위를 합친다. FTS는 Space 조건과 Unicode61 접두어 검색을 유지한다. AI/Vectorize는 별도의 파생 검색 경로다. HOT의 본문·FTS·접두어 인덱스는 실제 D1 저장량과 조회 비용을 차지한다.

## 기존 inline 자료와 정리

`STORAGE_BACKFILL_ENABLED=true`일 때만 제한된 이관을 실행한다. 호출당 current/history 각각 한 후보를 cursor와 generation으로 선택하며, 정확한 원문·revision이 그대로일 때만 archive를 발행한다. 기존 작성자의 활성 credential에 의존하지 않는 내부 유지보수 경로이고 공개 이관 API는 없다. 원문, 이력 revision, 감사 및 논리 사용량을 보존한다. 과거 revision의 HOT 검색 사본은 별도 retirement outbox로 정리하고 canonical R2는 보존한다.

미발행 intent GC는 한 번에 최대 5개 intent/100개 payload 위치를 수집한다. 외부 purge/retirement는 최대 4건, 동시 2건, 전체 60초 예산으로 처리하며 실패는 backoff 후 재시도한다. 영구 제거는 중앙 접근 차단과 durable purge outbox를 먼저 기록한다. R2와 HOT의 tombstone이 늦은 쓰기의 재등장을 막는다. 접근 제거 receipt는 물리 정리 완료 증명이 아니며 backlog와 실패를 별도로 확인한다.

## 유한한 용량과 비용

D1 한 DB의 Paid 최대 용량은 10GB이며 상향할 수 없다. 중앙 metadata DB도 이 한도와 순차 쿼리 처리의 영향을 받는다. HOT을 추가해도 중앙 head·history pointer·identity·audit·receipt의 용량이나 쓰기 병목이 없어지지 않는다. 각 DB의 물리 크기·증가율·지연·읽고 쓴 행 수, R2 요청/저장량, 검색 fan-out, 정리 backlog를 함께 계측한다. [Cloudflare D1 공식 한도](https://developers.cloudflare.com/d1/platform/limits/)

D1 `batch()`는 한 DB의 SQL 트랜잭션이다. 중앙 D1, 다른 HOT D1, R2를 하나의 원자적 트랜잭션으로 묶지 않으며 위 prepare/publish/cleanup 절차가 장애 복구를 담당한다. [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

선택한 GA는 초대 기반·사용량 계량·AI 검색/추출이며 유료 결제는 제외한다. AI 호출 예약 상한과 고객 quota는 서로 다르다. Production AI 예산 $20 및 staging $0.20은 Memory 전체 Cloudflare 월 $50의 자동 상한이 아니다. D1/R2/Workers/Vectorize 비용과 증가 속도에 대한 운영 경보·중단 판단이 필요하다.

## 복구 검증

중앙 snapshot 하나만 복구해서는 외부 payload와 권한 상태를 복구할 수 없다. 중앙 pointer와 R2 object hash, HOT schema/재구축 자료, snapshot 이후의 회수·제거 기록을 함께 보존하고 격리 환경에서 검증한다. 실제 provider의 전체 D1 export는 FTS virtual table 때문에 거절되었다. 명시적인 일반 테이블 export와 별도 DDL/파생 FTS 재구축 절차를 사용하며, 해당 exporter의 native 검증은 진행 중이다. 이를 이미 성공한 원격 복구 훈련으로 기록하지 않는다. [D1 import/export 제약](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [다중 저장소 복구](release/MULTI_STORE_RECOVERY.md)

최종 revision의 부하·비용·격리 복구 및 수락 서명은 아직 별도 gate다. [배포 절차](release/DEPLOYMENT.ko.md)와 [현재 통합 기록](release/INTEGRATION.md)을 따른다.
