# 배포·승격 절차

## 현재 대상

후보는 **0.5.0-rc.1, 중앙 migrations 1–25와 HOT schema 1**을 요구한다. Production `memory.allenlabs.org`는 rc.3/중앙 1–7 그대로이며, staging `memory-staging.allenlabs.org`는 이전 revision `1a93820`/중앙 1–23/HOT 1이다. 24–25는 아직 배포하지 않았다. 기존 개인용 Worker와 DB는 별도 서비스다. 실제 적용 상태와 검증은 [INTEGRATION.md](INTEGRATION.md)에서 구분한다.

`wrangler.jsonc`는 production 대상이므로 staging 시험에 그대로 쓰지 않는다. staging 명령에는 항상 `--config .\wrangler.staging.jsonc`를 지정한다. 인수 없는 명령은 production 설정을 사용한다. 기존 production DB UUID를 재생성·교체하거나 개인용 DB로 대체하지 않는다.

## 필수 설정과 마이그레이션

| 항목 | 후보 계약 |
| --- | --- |
| 기본 | 정확한 `PUBLIC_ORIGIN`, 중앙 SSO `SSO_CLIENT_ID`, `/auth/callback` 및 resource/audience. 인증 UI/API는 기존 allen.company 도메인 유지 |
| 중앙 D1 | `DB`, `migrations_dir: migrations`. 새 환경은 0001–0025 전부 적용. Production은 0008–0025, 현재 staging은 0024–0025를 추가 적용한 뒤 후보 배포 |
| HOT/R2 | `STORAGE_MODE=sharded`, 서로 다른 물리 HOT D1, 최대 16 active/draining registry 항목, 비공개 `MEMORY_PAYLOADS`. 모든 HOT에 `shard-migrations/0001_payloads.sql` 적용 |
| 가입·계량 | `GA_PROFILE=managed-ai-metered`, `ENROLLMENT_MODE=invite`, secret `ENROLLMENT_EMAIL_HASHES_JSON`, UTC 월 단위 AI 호출 예약 예산 |
| AI·검색·추출 | `BACKGROUND_JOBS_ENABLED=true`, `AI`, 1024차원 cosine `MEMORY_INDEX`, `PAYLOAD_KEY`. 실제 provider 응답·색인 지연·검토 후 승인 확인 |
| 메일 | 네이티브 `EMAIL`, `MAIL_FROM`, 등록된 발신 도메인. 실제 수신·proof 소비는 별도 수락 gate |
| Identity lifecycle | Memory `IDENTITY_WEBHOOK_SECRET`와 중앙의 해당 환경 delivery secret. 중앙 발행기 배포는 별도 단계이며 현재 미배포 |
| 결제·보존 | `PAID_BILLING_ENABLED=false`: 이번 GA에서 유료 결제 제외. `AUTO_ERASURE_ENABLED=false` 유지. 명시적 최근-proof 영구 제거는 별도 |
| 이관 | `STORAGE_BACKFILL_ENABLED`는 명시적 opt-in. draining 설정은 기존 payload 자동 이동이 아님 |
| 관측·승격 | invocation logging 비활성, `RELEASE_MODE=pilot`. 최종 증거의 `LIVE_ACCEPTANCE_JWS`와 대응 공개 키가 필요하며 ID 문자열만으로 승인되지 않음 |

AI 호출 예약 예산은 production 최대 $20, staging $0.20이다. 고객 사용량도 별도로 계량한다. Memory 전체 Cloudflare 월 $50 목표는 Workers/D1/R2/Vectorize의 실제 청구·경보·중단 절차까지 관리해야 하며 AI 설정만으로 보장되지 않는다.

| 신규 migration | 역할 |
| --- | --- |
| 0008–0021 | checkout 재시도, queue 진행, SCIM tombstone, 범위별 조회, DB 실행 시각 admission, 원자적 DNS 검증·proof 보존. 기존 이력은 [과거 통합 기록](INTEGRATION.md#historical-040-rc4-integration-record)에 보존 |
| 0022_payload-schema.sql | 중앙 payload pointer·논리 크기·durable intent·purge/retirement outbox, inline 호환 이관 |
| 0023_operational-schema.sql | 서비스 전체 월별 provider 예약, 제한된 inline backfill index/cursor |
| 0024_lifecycle-schema.sql | 순서 있는 계정/정확한 이메일 lifecycle 수신 및 서명된 최신 event의 로그인 전 적용 |
| 0025_queue-episode-schema.sql | 현재 queue episode 시각. 원래 생성 시각 보존, 복원할 수 없는 과거 episode는 unknown |

모든 남은 migration은 선택 사항이 아니다. `/ready`는 중앙 25/HOT 1을 검사하며 구 schema에 최신 Worker를 배포하면 새 column/table 조회가 실패한다. 이미 적용한 migration은 변경하지 않는다. 22의 원격 parser 호환 구문도 검증된 파일 그대로 사용한다.

## 검증과 배포 순서

1. revision·dirty 상태·대상 config를 확인하고 `npm ci`, `npm run check`, `npm run test:d1`을 실행한다. 현재 최종 전체 테스트 수는 재실행 후 통합 기록에 추가한다.
2. 승인된 대상의 중앙/HOT/R2/Vectorize 리소스를 대조하고 복구 bookmark와 회수·erasure 증거를 보존한다. R2의 public domain 설정도 독립 확인한다.
3. `npm run preflight -- --config .\wrangler.staging.jsonc`, `npm run build -- --config .\wrangler.staging.jsonc`로 대상과 bundle을 검증한다.
4. `npm run db:remote -- --config .\wrangler.staging.jsonc`는 등록된 active/draining HOT 전체를 먼저 적용하고 중앙 DB를 마지막에 적용한다. 실패하면 적용된 DB/버전을 조사한 뒤 재개한다.
5. `npm run deploy -- --config .\wrangler.staging.jsonc`는 깨끗한 Git source와 전체 check를 요구한다. deploy가 migration이나 native/live 검증을 대신 수행하지 않는다.
6. 최종 revision에서 [GA_ACCEPTANCE.md](GA_ACCEPTANCE.md)의 15개 증거 gate를 실행한다. 이전 staging의 SSO/PAT·공식 SDK·AI·10단계 조직 격리·CRUD/복원/제거·계량 성공은 그 revision의 기록이며 최신 후보 승인으로 재사용하지 않는다.
7. 실제 메일 수신·proof 소비, 중앙 lifecycle 배포/전송 지연·재시도·회수/재개, 격리 복구, 부하·비용·경보 대응을 완료한다. 유료 결제 시험은 이번 GA의 필수 gate가 아니다.
8. 정확한 source/config/schema와 15개 증거 hash에 묶인 짧은 기한의 서명을 설치하고 운영자가 승격한다. `LIVE_ACCEPTANCE_ID`만 설정하거나 liveness 200을 확인한 것은 승인이 아니다.

중앙 lifecycle은 private source와 두 Worker/native D1에서 구현·검증되었지만 아직 중앙에 배포하지 않았다. 환경별 secret을 나누고 대상은 정확히 production 및 hyphenated staging origin만 허용한다. 순서 지연과 재전송을 포함해 실제 전송 후 확인한다.

## 복구 주의

구버전 Worker만 다시 배포하는 것을 안전한 복구로 취급하지 않는다. 구 writer는 새 pointer·권한·제거 정책을 해석하지 못할 수 있다. 외부 트래픽을 차단한 격리 복구본에서 중앙 authority, R2 object/hash, HOT 재구축과 snapshot 이후의 회수·제거를 함께 확인한다.

실제 전체 D1 export는 FTS virtual table에서 거절되었다. 일반 테이블을 명시해 실제 staging 중앙/HOT D1에서 내려받은 SQL을 독립 native D1로 복원하고, 보존된 모든 테이블의 내용·DDL/FTS 재구축·외래 키를 대조하는 검증은 통과했다. 이 읽기 전용 캡처는 쓰기를 중지하지 않은 관찰이므로 일관된 백업이나 원격 격리 복구 훈련의 완료를 의미하지 않는다. [MULTI_STORE_RECOVERY.md](MULTI_STORE_RECOVERY.md)와 [운영 문서](OPERATIONS.ko.md)를 따른다.
