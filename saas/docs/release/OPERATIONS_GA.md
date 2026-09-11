# 초대 GA 운영 관찰과 대응

이 절차는 [GA 수락](GA_ACCEPTANCE.md)의 `observability-response`, `metering-quotas`, `operational-policy` 증거를 지원한다. `operations-cli.mjs`는 실제로 수집한 집계 자료를 평가하는 읽기 전용 도구다. provider 수집·경보 발송·메일·자동 차단·배포를 수행하지 않으며 `alertDelivered:false`, `providerMutation:false`를 반환한다. 별도 수집 wrapper와 담당자에게 도달하는 실제 경보 시험은 운영자가 연결·검증해야 한다.

## 실행과 연결 계약

Node 24, `saas/`에서 실행한다. 독립된 실제 target 설정을 항상 명시한다. `--env`, 임의 provider 인수, credential 인수는 거부한다. `--out`은 선택 사항이며 기존 파일을 덮어쓰지 않는 UTF-8 원자적 출력이다. 파일은 공개 저장소 밖에 둔다. stdout도 정제된 JSON이다.

```powershell
node --experimental-strip-types scripts/operations-cli.mjs plan --config C:\private\staging.jsonc --out C:\private\operations-plan.json
# 운영자의 읽기 전용 CF/D1 adapter가 plan을 실행하고 snapshot.json을 작성한다.
node --experimental-strip-types scripts/operations-cli.mjs assess --config C:\private\staging.jsonc --snapshot C:\private\snapshot.json --out C:\private\assessment.json
# 명시적으로 선택한 임계값만 기본값 위에 적용한다.
node --experimental-strip-types scripts/operations-cli.mjs assess --config C:\private\staging.jsonc --snapshot C:\private\snapshot.json --policy C:\private\thresholds.json
```

종료 코드 `0`은 제공된 최신 자료에서 기준 위반을 발견하지 못했다는 뜻이다. `2`는 대응 항목 또는 핵심 관찰값 미확인, `1`은 잘못된 입력·설정·수집 실패다. **1과 2 모두 운영 wrapper가 담당자에게 전달해야 한다.** 코드 0도 외부 감시가 동작한다는 증거가 아니다. 알려진 실패 snapshot으로 실제 전달·확인·조치 시간을 기록한다.

직접 연결할 함수는 `createOperationsPlan(validatedTarget,{now})`, `assessOperations(validatedTarget,snapshot,{now,policy})`, `runOperationsCommand(argv,options)`다. target은 기존 `loadDeploymentConfiguration({configPath})` 결과를 사용한다. 원격 요청은 root/operator 소유 wrapper에서 수행하고 토큰은 별도 secret 경로로 전달한다. 명령 자체는 네트워크 요청을 하지 않는다.

## 실제 수집 자료

plan의 `d1[]`은 `{id,binding,sql,params,columns,maxRows,category}`다. 각 binding의 실제 D1에서 해당 SELECT만 실행하고 결과 rows를 `database.results[id]`에 넣는다. SDK/provider response 전체를 넣지 않는다. 조회 실패는 해당 값을 `null`로 남기고 원문 오류는 비공개 수집 로그에 보관한다. 누락은 0으로 바꾸지 않는다. 쿼리는 token·사용자·memory ID·본문·원문 error를 반환하지 않는다.

| 관찰 | 실제 구현·범위 |
|---|---|
| Heartbeat | `release_heartbeats`의 `maintenance` PK 조회. scheduled 전체가 성공한 마지막 시각이다. GC가 부분 실패했어도 작업이 반환하면 heartbeat가 갱신될 수 있으므로 queue 실패 지표도 함께 본다. |
| Provider jobs | `release_jobs_pending_claim`, `release_jobs_leased_claim`, `release_jobs_exhausted_lease`, `release_jobs_due` 인덱스. 종류·cleanup/state별 현재 queue episode 시작(`queued_at`)/예약/lease 시각, attempt, error 유무만 최대 1,001개 읽는다. |
| Payload cleanup | `release_payload_intents_expiry`, `release_payload_purges_pending`, `release_payload_retirements_pending` 인덱스로 미수거 intent·미완료 purge/retirement를 읽는다. 미래 retry 예약도 숨기지 않는다. |
| Backfill | 두 `release_payload_backfill_progress` 행의 generation/시각/error 유무와 partial index의 inline 후보 최대 1,001개. cursor의 memory ID는 내보내지 않는다. |
| AI 예약 | UTC 월의 `release_provider_budgets` 두 행을 읽는다. 고객 `release_usage_counters`의 사용량 단위를 Cloudflare 청구액으로 해석하지 않는다. |
| HOT tombstone | 각 shard에서 처음 1,001개까지만 세어 하한을 기록한다. 영구 표식을 정리 대상으로 제안하지 않는다. |
| DB/R2 용량 | 실제 CF D1 metadata/GraphQL 및 R2 usage/inventory에서 byte·object 집계를 수집한다. binding 파일만으로 실제 크기나 공개 여부를 추정하지 않는다. |

queue count가 1,001이면 정확한 총계가 아니며 `queue_sample_saturated`로 대응한다. `oldestObservedAgeSeconds`도 인덱스 순서에서 본 표본의 최대 나이로, 전체 큐의 절대 최댓값을 보장하지 않는다. 오래된 미래 retry가 표본 밖에 있으면 이 한계가 적용된다. 전체 COUNT/MIN으로 무제한 스캔하지 않는다. backlog 포화 시 별도 제한된 page 조사·provider 처리율·작업 상태를 확인한다.

중앙 schema25는 원래 job 생성 시각(`created_at`)을 보존하고 새 삽입 또는 `done/dead→pending`에서 DB 실행 시각을 `queued_at`에 기록한다. 정상 reconciliation은 새 episode이며, pending/leased retry와 continuation은 같은 episode라 나이를 초기화하지 않는다. 기존 행은 최초 availability가 creation과 같은 active episode만 안전하게 backfill한다. 재시도·재대기 시작을 복원할 수 없는 기존 행의 `queuedAt`은 `null`, 해당 표본 나이도 `null`이며 `queue_episode_unknown`으로 표시한다. 관찰되지 않은 시작 시각을 0이나 원래 생성 시각으로 추측하지 않는다.

현재 telemetry는 `index1=memory`, `blob1=route 분류`, `blob2=method`, `blob3=status`, `double1=1`, `double2=durationMs`다. URL/query/header/body/account/email/token은 수집하지 않는다. plan의 Analytics Engine SQL은 5분 window에서 `_sample_interval` 가중 request/5xx 합계와 weighted p95를 계산한다. 표본 비율을 무시한 raw COUNT/quantile을 사용하지 않는다. [Cloudflare sampling 문서](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)가 이 가중 방식의 기준이다.

같은 Worker·같은 window의 **HTTP request** 수를 독립 CF GraphQL/primary usage에서 `primaryRequests`로 수집한다. scheduled invocation 수를 섞지 않는다. telemetry는 기록 실패가 응답을 바꾸지 않으므로 AE가 0이라고 실제 요청도 0이라고 가정할 수 없다. primary가 있는데 AE가 없거나 primary 20건 이상에서 AE가 절반 미만이면 coverage gap으로 표시한다. 이는 sampling/집계 지연을 포함해 조사할 신호이며 손실률의 정확한 추정은 아니다. live SQL/GraphQL adapter의 필드·권한·지연은 별도 실환경 수락 대상이다.

## Snapshot 형식

최상위 필드는 정확히 `format:1`, `environment`, `resourceFingerprint`, `collectedAt`, `database`, `capacity`, `traffic`, `budget`이다. fingerprint는 선택한 설정의 `deploymentFingerprint(config)`, 시각은 epoch milliseconds다. 뒤 네 자료 묶음은 미확인 시 `null`이 가능하며 critical unknown으로 보고한다. 미래 시각·과도한 배열·비정상 숫자·예상 외 필드·다른 target은 거부한다. JSON 입력은 4 MiB, 설정은 1 MiB, policy는 16 KiB 한도다.

- `database:{observedAt,month,results:{<plan query ID>:rows|null}}`. month는 실제 `ai-budget` 쿼리에 바인딩한 UTC `YYYY-MM`이다. 지연 응답이 새 달에 도착해도 이전 달 예약을 현재 값으로 오인하지 않는다. 정해진 column만 반환하고 각 row limit을 넘기지 않는다.
- `capacity:{observedAt,databases:[{binding,bytes,limitBytes}],r2:{bytes,objects,purgedObjects}|null}`. DB와 모든 HOT를 정확히 한 번 포함한다. `limitBytes`는 실제 계정/DB의 제한이다. `purgedObjects`를 실제 inventory로 세지 못하면 `null`이며 0으로 쓰지 않는다.
- `traffic:{observedAt,windowSeconds,requests,primaryRequests,serverErrors,p95Ms,sampled}`. request/error는 가중 집계, primaryRequests 미확인은 `null`; 둘 다 실제 0이면 p95Ms는 `null`이다. window는 60–3,600초, 기본 수집 계획은 300초다.
- `budget:{observedAt,month,scope:"memory-staging-production",environments:["production","staging"],evidenceRef,complete,costs:[{category,usd,basis}]}`. category는 `workers,d1,r2,vectorize,analytics,ai,other`를 각각 한 번 포함한다. basis는 `billed` 또는 `usage-estimate`다. evidenceRef는 비공개 원본 기록의 안전한 ID이며 URL/secret을 넣지 않는다.

## 비용과 기본 대응 기준

월 총 예산은 **Memory staging+production 합계 USD50**이다. 각 환경을 따로 USD50으로 해석하지 않는다. Workers 기본/공유 요금, D1 저장·읽기·쓰기, R2 저장·요청, Vectorize, Analytics, AI, 기타 배분액을 빠짐없이 포함한다. 다른 프로젝트와 공유하는 account 요금의 Memory 배분 근거도 실제 evidence로 남긴다. primary capture가 없거나 한 환경/항목이 빠지면 합계·잔액을 `null`로 두며 정상으로 보지 않는다. 비용 출처를 숨긴 임의 숫자는 수락 증거가 아니다.

`release_provider_budgets.reserved_microusd`는 불확실한 provider 호출에도 환불하지 않는 보수적인 예약이다. production AI 한도는 최대 USD20, staging은 최대 USD0.20이다. 이 값은 **실제 청구액이 아니고 전체 Cloudflare USD50 상한도 보장하지 않는다.** 일시 중지는 유효한 양수 설정 `AI_MONTHLY_BUDGET_MICROUSD=1`을 사용한다. 현재 embedding 예약 200, extraction 예약 30,000 microUSD보다 작으므로 새 예약을 모두 거부하며 도구는 `ai_provider_admission_stopped`를 표시한다. 이미 예약하고 실행 중인 호출을 취소하거나 비용을 환불하지 않는다. 0은 readiness/수락의 양수 설정 계약에 맞지 않으므로 권장 중지 값이 아니다. 예약액은 청구 합계에 다시 더하지 않아 이중 계산을 피한다.

`usage-estimate`는 실제 usage와 명시한 단가에서 계산한 추정이며 확정 청구가 아니다. 도구는 이를 경고로 표시한다. 추정/확정 구분을 유지하고 공급자 가격·무료 구간·배분·보고 지연을 대조한다. monthly 현재 구간이 아니거나 하루 이상 지난 비용은 운영 판단에 부족하다. 비용을 모르는 동안 “남은 예산 충분”이라고 표시하지 않는다.

| 지표 | 기본 warning / critical |
|---|---|
| Heartbeat·DB/traffic freshness | 15분 초과 또는 누락 critical |
| 용량·비용 freshness | DB/R2 1시간, 월 비용 24시간 초과 critical |
| Provider 현재 queue episode의 관찰 나이 | 15분 / 60분; dead job·exhausted expired lease는 즉시 critical |
| Payload purge/retirement 나이 | 5분 / 60분; 반복 attempt≥3·error 유무도 warning |
| 만료 intent 미수거 | 만료 후 5분 / 60분 |
| DB 크기 / 실제 한도 | 70% / 85% |
| 월 Memory 비용 | USD40 / USD45; USD50은 넘길 수 없는 정책 상한이며 자동 invoice 차단 기능은 아님 |
| AI 예약 / 설정 한도 | 80% / 100% |
| HTTP 5xx 비율 | 1% / 5%, 20건 이상; 소량에서도 오류가 있으면 warning |
| p95 지연 | 2초 / 5초, 20건 이상 |

이 값은 초대 GA의 보수적 초기 운영 기준이며 부하 시험이나 SLO 보장이 아니다. policy JSON은 `DEFAULT_POLICY`의 키만 명시적으로 바꾼다. 검토 기록 없이 경보를 끄는 용도로 사용하지 않는다. 월 critical threshold를 USD50보다 올릴 수 없다.

## 담당자 대응 순서

1. stale/unknown이면 collector 권한·target binding·window·provider 응답을 먼저 확인하고 실제 자료를 다시 수집한다. provider raw 오류를 공개 보고서로 복사하지 않는다. 5xx/latency는 동일 시간의 GC·queue·capacity·provider 비용/실패와 대조한다.
2. 예산·backlog·용량 위험이면 신규 초대 roster를 닫고 필요 시 외부 요청을 제한한다. roster를 닫는 것은 기존 사용자의 쓰기를 중지하지 않는다. 기존 트래픽의 admission 제한은 검증된 별도 운영 통제다. AI 예산 1 microUSD, `STORAGE_BACKFILL_ENABLED=false`, 필요 시 `BACKGROUND_JOBS_ENABLED=false` 변경은 승인된 운영 경로로 적용하고 결과를 관찰한다. 예산 변경은 리소스/정책 지문을 바꾸므로 기존 GA attestation이 계속 유효하다고 가정하지 않는다. 재개 전 정상 예산과 나머지 수락 조건을 다시 검증한다.
3. **cron과 `PayloadMaintenance`를 멈추지 않는다.** 현재 scheduled 경로는 provider jobs flag와 별개로 payload purge/retirement·transient maintenance를 수행한다. backfill은 별도 flag로 중지한다. 다만 background flag를 끄면 vector delete drain도 멈추므로 privacy cleanup 지연을 기록하고 통제된 재개 계획을 세운다. “모든 삭제 완료”라고 안내하지 않는다.
4. immutable intent/receipt/erasure ledger와 R2/HOT tombstone은 용량을 확보하려고 지우지 않는다. 시간별 실제 DB bytes·retained-object 수를 보관해 증가율을 측정한다. 표본 count가 포화되면 실제 총 증가량은 알 수 없으며 별도 제한된 inventory와 전체 저장량을 사용한다.
5. HOT는 애플리케이션 registry 최대 16개이고 14개부터 확장 여유 warning이다. draining까지 포함한다. 물리 shard를 늘려도 중앙 권한/발행/회수 기록은 중앙에 남으므로 중앙 용량 문제는 별도 해결해야 한다. Cloudflare의 DB당 한도는 paid 10 GB, free 500 MB이며 10 GB 자체는 늘릴 수 없다. 실제 byte 단위 한도를 capture에 넣고 85% 이전에 충분한 이행 여유를 확보한다. [공식 D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
6. 복구가 필요하면 [격리 복구 절차](MULTI_STORE_RECOVERY.md)를 실행한다. live R2를 이전 백업으로 덮어쓰지 않고, 회수·erasure·tombstone을 먼저 재조정한다. 운영자는 RPO/RTO 실측과 복구 후 negative authority test를 남긴다.

자동 경보 전달/ack, 합계 청구 수집 adapter, 실제 중지/재개 시험, 장기 시계열 보관과 예산 알림의 도달성은 이 평가 도구만으로 완료되지 않는다. root/operator가 실제로 실행한 증거를 GA gate에 연결한다.
