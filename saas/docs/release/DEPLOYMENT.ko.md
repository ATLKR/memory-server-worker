# 배포·승격 절차

## 저장소와 DB 분리

기존 개인용 Worker는 그대로 둔다. 적용 도구는 새 로컬 저장소 사본을 만든다. 원본 `saas/wrangler.jsonc`에는 기존 SaaS production 설정이 남아 있으므로 **적용 직후 `npm run deploy`를 실행하지 않는다.** 우선 `config/wrangler.staging.example.jsonc`를 참고하여 새 사본의 SaaS 설정을 전용 staging 도메인·D1·Vectorize로 바꾼다. 예제의 0으로 된 DB ID는 의도적으로 유효 배포를 막는다.

원본 커밋 이후에 다른 작업이 진행됐다면 이 패키지에서 바뀐 파일과 그 작업을 별도 review로 합쳐야 한다. 해시 검증을 제거하거나 `once` 패치 anchor를 무조건 맞추는 방식으로 진행하지 않는다.

## 설정

| 종류 | 설정 |
|---|---|
| 기본 | `PUBLIC_ORIGIN`, 원본 중앙 SSO에 등록한 staging `SSO_CLIENT_ID`, 정확한 redirect URI `/auth/callback` 및 resource/audience |
| D1 | 전용 `DB`, 원본 migration 0001–0005 + 추가 0006 |
| 검색 | Workers AI binding `AI`, 1024차원 cosine Vectorize index `MEMORY_INDEX`. 실제 모델 출력으로 차원·응답을 확인하고 등록 |
| 추출 | `PAYLOAD_KEY`: 무작위 32바이트 base64url. `.dev.vars`와 Git에 운영 secret을 커밋하지 않음 |
| 메일 | Cloudflare Email Sending 등록 도메인, 네이티브 `EMAIL` binding, `MAIL_FROM`. [설정·검증](EMAIL.md) |
| 회수 이벤트 | 중앙 인증 발행기와 같은 `IDENTITY_WEBHOOK_SECRET`; 다른 환경의 secret을 재사용하지 않음 |
| 결제 | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, 계정에서 실제 검증한 고정 `STRIPE_API_VERSION`, `BILLING_PRICES_JSON` |
| 유지보수 | 매분 cron. index upsert/delete/ingest 기본 5개, billing event 기본 3개를 처리하므로 실제 유입량과 backlog를 확인 |
| 관측성 | 선택적 Analytics Engine `METRICS`. 원본의 invocation logging 비활성화를 유지하여 OAuth code 포함 URL이 로그에 남지 않게 함 |
| 승격 | 기본 `RELEASE_MODE=pilot`, 승인 전 `LIVE_ACCEPTANCE_ID`는 비워 둠 |

예시 파일은 설정 형식일 뿐 실제 provision 작업을 수행하지 않는다. 새 패키지의 provider adapter는 추가 npm 패키지를 요구하지 않는다. 원본 저장소의 잠금 파일과 의존성 버전은 그대로 유지한다.

## 로컬·staging 순서

1. ZIP 무결성 검사와 로컬 테스트 후 copy-only assembler를 실행한다.
2. `tools/verify-upstream.mjs`로 원본 migration 전체를 로컬 메모리 DB에서 검증한다. 이어 원본 Node 요구사항을 맞추고 `npm ci`, `npm run check`, `npm run test:d1`을 실행한다.
3. 별도 staging resources와 SSO client를 만들고 secrets를 secret store에 넣는다. 승인된 staging DB에만 migrations를 적용한다. Cloudflare 명령의 대상 account/DB/domain을 사람이 확인한다.
4. 본문에 개인정보가 없는 합성 데이터로 로그인, key, 검색, 삭제, export, 공유, 회수, 추출을 확인한다. 실제 provider 호출 비용과 메일 발송이 발생할 수 있으므로 이 단계부터 계정 운영자가 실행한다.
5. 결제 test mode와 운영 복구 훈련을 통과시킨다. `LAUNCH-GATES.ko.md`의 추가 구현 항목까지 판정한다.
6. 실제 production 승격 전 독립 snapshot과 erasure ledger를 확보하고, 구버전 writer/consumer를 차단한 정비 창에서 새 schema와 새 Worker를 함께 승격한다. 개별 provider endpoint와 실제 브라우저 smoke를 다시 수행한다.

## 되돌리기 주의

0006은 복원 및 본문 제거를 위한 상태 전이를 추가한다. 기존 Worker만 다시 배포하면 새 권한 정책·상태를 해석하지 못할 수 있다. **구버전 코드만 롤백하는 것을 안전한 복구로 취급하지 않는다.** 읽기 제한/정비 모드에서 원인을 수정해 앞으로 이동하거나, 독립 환경에 이전 DB를 복구한 뒤 이후 권한 회수와 영구 삭제를 재적용하고 인덱스를 재구축한 후 검증하여 승격한다.
