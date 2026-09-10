# 배포·승격 절차

## 저장소와 DB 분리

이 문서는 통합된 저장소의 배포 절차다. 현재 배포·검증 상태는 [INTEGRATION.md](INTEGRATION.md), 상세 운영 절차는 [상위 운영 문서](../OPERATIONS.md)를 따른다. ZIP 전용 assembler와 staging 예제는 이 저장소에 포함되어 있지 않다.

기존 개인용 Worker와 DB는 별도 서비스다. `saas/wrangler.jsonc`는 실제 SaaS production을 가리키므로 staging 시험에 그대로 사용하지 않는다. staging에는 별도 도메인·D1·SSO client와 필요한 provider binding을 구성한다. 기존 production D1을 재생성하거나 UUID를 교체하지 않는다. 적용된 migration 1–7의 해시 검증을 제거하지 않는다.

## 설정

| 종류 | 설정 |
|---|---|
| 기본 | `PUBLIC_ORIGIN`, 원본 중앙 SSO에 등록한 staging `SSO_CLIENT_ID`, 정확한 redirect URI `/auth/callback` 및 resource/audience |
| D1 | 전용 `DB`. Production rc.3 적용 기록은 0001–0007이며, 이 PR Worker 배포 전에는 새 0008_checkout-schema.sql, 0009_job-progress-schema.sql, 0010_protocol-schema.sql, 0011_pagination-schema.sql, 0012_lookup-schema.sql, 0013_key-lookup-schema.sql, 0014_tenant-queue-schema.sql, 0015_workspace-lookup-schema.sql, 0016_retrieval-progress-schema.sql, 0017_vector-reconciliation-schema.sql, 0018_outbound-share-schema.sql, 0019_execution-time-schema.sql, 0020_domain-verification-schema.sql, 0021_domain-retention-schema.sql을 순서대로 적용. 새 환경은 0001–0021 적용. 후보 `/ready`의 필수 schema 버전은 21 |
| 검색 | Workers AI binding `AI`, 1024차원 cosine Vectorize index `MEMORY_INDEX`. 실제 모델 출력으로 차원·응답을 확인하고 등록 |
| 추출 | `PAYLOAD_KEY`: 무작위 32바이트 base64url. `.dev.vars`와 Git에 운영 secret을 커밋하지 않음 |
| 메일 | Cloudflare Email Sending 등록 도메인, 네이티브 `EMAIL` binding, `MAIL_FROM`. [설정·검증](EMAIL.md) |
| 회수 이벤트 | 중앙 인증 발행기와 같은 `IDENTITY_WEBHOOK_SECRET`; 다른 환경의 secret을 재사용하지 않음 |
| 결제 | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, 계정에서 실제 검증한 고정 `STRIPE_API_VERSION`, `BILLING_PRICES_JSON` |
| 유지보수 | 현재 5분 cron은 만료 임시 상태를 정리. `BACKGROUND_JOBS_ENABLED=false`, `AUTO_ERASURE_ENABLED=false` 유지. Provider 처리 활성화 시 호출당 index/ingest 기본 5개, billing event 기본 3개의 처리량과 backlog 검증 |
| 관측성 | 선택적 Analytics Engine `METRICS`. 원본의 invocation logging 비활성화를 유지하여 OAuth code 포함 URL이 로그에 남지 않게 함 |
| 승격 | 기본 `RELEASE_MODE=pilot`, 승인 전 `LIVE_ACCEPTANCE_ID`는 비워 둠 |

설정 파일만으로 원격 리소스가 준비되지는 않는다. 통합 저장소의 `package-lock.json`과 지원 Node 버전으로 재현하고, 실제 provider 설정과 수신·콜백은 별도로 검증한다.

0008은 checkout의 실제 시도 여부를 기록하고 시도한 요청의 만료 시각을 고정한다. 기존 행은 공급자 호출 이력을 단정할 수 없으므로 모두 시도된 요청으로 보존한다. 0009는 인덱싱·벡터 정리 진행 위치를 저장하여 제한된 작업을 다음 실행에서 이어간다. 0010은 공급자로 확인한 기존 결제 종료와 SCIM 삭제 이력을 보존한다. 0011은 페이지 조회용 인덱스를 추가한다. 0012–0013은 FTS 행과 멤버십의 정확한 조회를 적용한다. 0014는 Space별 검색과 목록, 제한된 작업 선택·유지보수 진행 상태를 추가하며 검색 인덱스를 재구축한다. 0015는 작업공간·키 후보와 본문 제거 대상 조회를 위한 인덱스·cursor를 추가한다. 0016은 Space별 운영 목록·재구축 인덱스와 비동기 벡터 삭제 확인 상태를 추가한다. 0017은 늦게 완료된 벡터 upsert를 정리할 수 있도록 삭제 대기 페이지의 재시도 시각과 간격을 저장한다. 0018은 `release_shares(space_id,created_at DESC,id DESC)`에 `release_shares_space_created` 인덱스를 추가하여 발급 이력을 Space별 최신순으로 제한 조회한다. 기존 grant와 시각은 보존한다.

0019와 애플리케이션 SQL helper는 애플리케이션이 바인딩한 시각과 DB 문장이 실제 실행되는 시각 중 더 늦은 값을 기한 판단에 사용한다. DB 큐에서 기다리는 동안 credential·멤버십·최근 proof·복원 기간·ingest·lease가 만료되면 이전 시각만으로 나중의 변경을 허용하지 않는다. 기존 기록 시각과 변경 불가 이력은 보존하며, 최근 proof 사용 처리와 credential의 본인 확인 시각 갱신은 한 SQL 문장과 trigger에서 원자적으로 처리한다.

0020은 DNS challenge 소비·도메인 생성/갱신·정확한 관리자 멤버십 연결을 하나의 검증 receipt와 trigger 문장으로 원자적으로 처리한다. 완료 receipt 재조회는 동일 계정의 현재 session·최근 proof·기존 멤버십과 회수되지 않은 관리자 위임·도메인 및 receipt 유효기간을 다시 확인하며, DNS 재조회나 기간 연장 없이 원래 `verifiedUntil`을 반환한다. 수락된 공급자 이메일 회수 이벤트는 정확한 계정·주소의 미사용 proof를 무효화한다. 기존 차단에 대한 backfill도 아직 사용·무효화되지 않은 해당 proof만 DB 실행 시각으로 처리하며, 소비된 proof와 변경 불가 이력은 보존한다.

0021은 미사용 DNS challenge의 만료 인덱스를 추가한다. 정리는 만료된 미사용 challenge를 한 번에 최대 100개 처리하고 소비된 DNS proof와 검증 receipt는 보존한다.

`/ready`의 schema 검사를 통과하려면 0021까지 적용해야 한다. **0008–0021은 PR에만 있으며 production 적용 기록은 rc.3와 0001–0007이다.** 현재 전체 로컬 검증은 1,410개 테스트를 통과했다. 완료된 native 기록은 데이터가 있는 5→21 업그레이드·큐 만료 6건·도메인 검증/보존 10건·인증/HTTP 7건을 포함한다. 각 실행의 소스 범위와 실환경 수락 조건은 [검증 기록](INTEGRATION.md)을 확인한다. 아래 절차는 배포 완료 기록이 아니다.

## 로컬·staging 순서

1. 검토할 Git revision과 작업 디렉터리 변경 사항을 확인한다. ZIP 통합은 이미 완료됐으므로 assembler를 다시 실행하지 않는다.
2. `saas/`에서 지원 Node 버전으로 `npm ci`, `npm run check`, `npm run test:d1`을 실행한다. `check`는 migration source와 적용된 해시도 검증한다.
3. 별도 staging resources와 SSO client를 만들고 secrets를 secret store에 넣는다. 승인된 staging DB에만 migrations를 적용한다. Cloudflare 명령의 대상 account/DB/domain을 사람이 확인한다.
4. 본문에 개인정보가 없는 합성 데이터로 로그인, key, 검색, 삭제, export, 공유, 회수, 추출을 확인한다. 늦은 편집 응답이 최신 초안을 지우지 않는지, 확인된 공유 회수가 늦은 목록 응답으로 되돌아가지 않는지도 확인한다. 실제 provider 호출 비용과 메일 발송이 발생할 수 있으므로 이 단계부터 계정 운영자가 실행한다.
5. 결제 test mode와 운영 복구 훈련을 통과시킨다. `LAUNCH-GATES.ko.md`의 추가 구현 항목까지 판정한다.
6. 실제 production 변경 전 복구 기준과 권한 회수·erasure 기록을 확보한다. 새 migration이 있으면 호환성을 검토해 먼저 적용하고 새 Worker를 배포한다. 로컬 `preflight`는 원격 권한·provider readiness를 증명하지 않는다. 개별 provider endpoint와 실제 브라우저 smoke를 수행하고 임시 배포 credential을 회수한다.

## 되돌리기 주의

0006은 복원 및 본문 제거를 위한 상태 전이를 추가한다. 기존 Worker만 다시 배포하면 새 권한 정책·상태를 해석하지 못할 수 있다. **구버전 코드만 롤백하는 것을 안전한 복구로 취급하지 않는다.** 읽기 제한/정비 모드에서 원인을 수정해 앞으로 이동하거나, 독립 환경에 이전 DB를 복구한 뒤 이후 권한 회수와 영구 삭제를 재적용하고 인덱스를 재구축한 후 검증하여 승격한다.
