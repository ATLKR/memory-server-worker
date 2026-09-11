# 운영·복구

현재 후보는 **0.5.0-rc.1/중앙 25/HOT 1**이다. Production은 rc.3/중앙 1–7, staging은 revision `141f65f`/중앙 1–25/HOT 1이다. 후속 수정과 1분 cron 설정은 아직 배포하지 않았다. 아래 현재 계약과 [통합 기록](INTEGRATION.md)의 과거 rc.4 검증을 구분한다. 선택한 GA는 초대 기반·사용량 계량·AI 검색/추출이며 유료 결제는 비활성으로 제외한다.

## 원본과 파생 데이터

중앙 D1이 identity·현재 권한·revision head/history pointer·논리 사용량·receipt의 기준이다. Sharded 모드의 canonical body/source/provenance는 비공개 R2에 있고 HOT D1은 불변 payload의 검색용 본문/FTS를 보관한다. 기존 inline 자료는 호환 읽기를 유지한다. 외부 payload를 읽은 뒤 중앙 최종 snapshot에서 현재 권한과 반환 revision·제거 상태를 검사한다. FTS와 Vectorize는 파생 인덱스이며 Vectorize에는 원문을 넣지 않는다. 벡터도 민감한 파생 자료로 취급한다.

`STORAGE_SHARDS_JSON`은 최대 16개의 active/draining 항목을 허용한다. 새 payload는 active로 분산되고 같은 Space도 두 물리 HOT를 사용할 수 있다. 저장된 위치를 재시도에서 다시 계산하지 않는다. draining은 새 배치 중단이며 기존 자료의 자동 이동이 아니다. 참조가 남은 binding을 제거하거나 다른 DB로 연결하지 않는다.

중앙 durable intent 이후 외부 준비를 수행하고 현재 SQL 권한·revision·quota 검사로 pointer와 receipt를 발행한다. 미발행 자료는 제한된 GC로 수거한다. `STORAGE_BACKFILL_ENABLED=true`일 때 current/history 각각 한 후보를 처리하며 정확한 내용·revision, 감사·논리 charge를 보존한다. 과거 HOT 사본 retirement와 R2/HOT purge는 durable outbox로 재시도한다. 중앙 DB와 각 HOT의 용량은 유한하다. [샤딩·용량 계약](../SCALING.md)을 따른다.

거절/충돌/권한 회수 후 API 재시도는 현재 SQL 권한으로 판단한다. 임시 대화를 자동 처리하는 ingest는 제출한 credential의 현재 권한을 확인한다. 기한이 지난 브라우저 session으로 제출한 ingest는 실행 시 권한 만료로 실패할 수 있다. 추출이 완료된 뒤의 사람 승인은 같은 계정의 현재 브라우저 session과 대상 Space의 create 권한으로 다시 승인하므로, 다시 로그인한 session에서도 검토를 마칠 수 있다. 장기 수집에는 용도와 유효기간이 제한된 create 전용 key를 쓰고 결과 열람은 별도 read 권한으로 한다. 저장이 완료된 기억의 인덱싱은 소유 계정·조직의 파생 작업이므로 작성자의 로그아웃·credential 만료·멤버십 회수와 별개로 진행한다. 각 새 embedding/upsert 직전에는 하나의 SQL 조회로 유효 lease, 현재 live revision, 소유 계정·조직의 활성 상태를 확인한다. 이미 요청된 공급자 작업의 결과와 제거용 식별자는 별도 정리 경로로 처리한다.

## 큐

`release_jobs`는 pending/leased/done/dead 상태와 attempt, lease_token, lease_until을 가진다. 120초 lease와 fencing으로 늦은 worker가 현재 결과를 덮어쓰지 않게 한다. 긴 인덱싱은 각 조각 사이에 동일한 유효 lease를 갱신하며, 만료되거나 다른 worker에 넘어간 lease는 되살리지 않는다. 실패 5회 후 dead로 가며 `/manage`에서 허용된 운영자가 재시도할 수 있다. 인덱스 재구축은 현재 revision별로 작업을 다시 만들고 실행 중 lease를 강제로 초기화하지 않는다.

현재 후보와 staging은 `BACKGROUND_JOBS_ENABLED=true`로 AI/vector/검토형 추출을 처리한다. 후보 cron은 1분이며 현재 배포본은 아직 5분이다. 호출당 작업량은 제한한다. 실환경에서 작업 대기로 제출자의 session이 만료된 경우 공급자 호출을 거부했고, 취소 후 새 credential로 새 제출을 하여 추출을 검증했다. `PAID_BILLING_ENABLED=false`, `AUTO_ERASURE_ENABLED=false`는 유지한다. 외부 자료는 중앙 발행 전 준비되고 semantic 반영은 지연될 수 있다. backlog와 현재 episode의 oldest age를 유입량에 맞춰 감시하며 무제한 처리량이나 고정 복구 시간을 약속하지 않는다.

0025의 `queued_at`은 최초 queue 진입과 done/dead→pending의 새 episode를 기록하고 같은 episode의 재시도에서 유지한다. 원래 `created_at`을 현재 대기 시작으로 오해하지 않는다. 이전 retry episode 시각을 복원할 수 없으면 unknown으로 남는다. 중앙 UTC 월별 provider 예약과 고객 사용량은 별도 계량이다. Production AI 예약 상한 $20, staging $0.20만으로 전체 Memory Cloudflare 월 $50를 보장하지 않으므로 D1/R2/Workers/Vectorize 실제 비용과 경보·중단 대응도 확인한다.

결제는 별도 DB lock과 유한량 consumer를 사용한다. webhook payload의 상태를 곧바로 적용하지 않고 공급자 현재 subscription을 조회한다. 이미 연결된 subscription은 주기적 재조회로 webhook 누락을 보완한다. 최초 subscription 생성 webhook 자체가 유실되어 아직 pool에 연결되지 않은 경우까지 자동 탐색하지는 않는다. 공급자 쪽 event replay와 checkout reconciliation 운영 절차가 필요하다. retry 한도를 넘긴 결제 이벤트는 운영자가 원인 해결 후 명시적으로 재처리해야 한다.

이 PR의 0008 checkout migration은 customer 생성 실패와 Checkout 호출 후 응답 유실을 구분한다. 아직 Checkout을 시도하지 않은 요청만 첫 호출 직전에 35분 만료 시각을 원자적으로 기록하며, 동시에 재시도한 호출도 저장된 동일 시각을 쓴다. 이미 시도된 요청은 응답을 받지 못했더라도 시도 표시나 만료 시각을 바꾸지 않는다. 0008 이전 행도 공급자 이력을 알 수 없어 시도된 요청으로 보존한다. `session_id=NULL`만 보고 미시도로 판단하지 말고 기존 idempotency key로 공급자 결과를 재조정한다. 만료된 요청을 다시 시작할 때는 새 operation ID가 필요하다. Production은 0008–0025를 추가 적용한 뒤 이 후보를 배포한다. Staging에는 중앙 0001–0025가 이미 적용되어 있다. 새 환경은 중앙 0001–0025와 모든 HOT의 `shard-migrations/0001_payloads.sql`이 필요하다. 후보 `/ready`는 중앙 25/HOT 1을 요구한다. 전체 검증 수는 최종 재실행 뒤 기록하며 과거 rc.4 수치를 현재 통과로 읽지 않는다. [검증 기록](INTEGRATION.md)에서 각 실행과 live gate를 구분한다.

0022는 payload pointer·논리 크기·intent·purge/retirement outbox, 0023은 월별 provider 예약과 inline 이관 cursor/index, 0024는 순서 있는 account/exact-email lifecycle, 0025는 queue episode 시각이다. 남은 migration은 결제 비활성 여부와 무관하게 모두 필수다.

0019_execution-time-schema.sql과 SQL helper는 애플리케이션 바인딩 시각과 DB 문장의 실제 실행 시각 중 더 늦은 값으로 기한을 검사한다. 요청이 DB 큐에서 기다리는 동안 credential·멤버십·최근 proof·복원 기간·ingest·lease가 만료되면, 큐 진입 전의 시각만으로 이후 변경을 허용하지 않는다. 기존 기록 시각과 변경 불가 이력은 보존한다. 최근 본인 확인 proof의 사용 처리와 해당 credential의 `reauthenticated_at` 갱신은 하나의 SQL 문장과 trigger에서 함께 적용하거나 함께 실패한다. Staging 검증에는 큐 대기 중 만료와 proof 소비 실패 시 전체 롤백을 포함한다.

0020_domain-verification-schema.sql은 DNS challenge 소비, 도메인 생성·갱신, 정확한 관리자 멤버십 연결을 하나의 검증 receipt와 trigger 문장으로 원자적으로 처리한다. 완료 receipt 재조회에는 동일 계정의 현재 브라우저 session·5분 이내 proof·원래의 유효 owner/admin 멤버십·회수되지 않은 도메인 관리자 연결과 도메인/receipt 유효기간이 필요하다. 응답 유실 후 같은 challenge ID로 재조회하면 DNS 확인이나 갱신을 반복하지 않고 원래 `verifiedUntil`을 반환한다.

수락된 공급자 이메일 회수 이벤트는 정확한 계정·주소의 미사용 pending proof를 무효화한다. 기존 차단이 남아 있으면 새 proof 발급·소비도 403으로 거절한다. 0020 backfill은 해당 차단에 일치하고 아직 사용·무효화되지 않은 proof만 DB 실행 시각으로 무효화하며, 소비된 proof와 변경 불가 이력은 보존한다. 0021_domain-retention-schema.sql은 미사용 DNS challenge 만료 인덱스를 추가한다. 정리는 한 번에 최대 100개의 만료된 미사용 DNS challenge만 제거하며 소비된 DNS proof와 검증 receipt는 보존한다.

0009는 인덱싱 조각과 벡터 정리 cursor를 현재 lease 아래에서 기록한다. 성공한 일부 작업은 실패 횟수를 늘리지 않고 다음 실행으로 넘긴다. 실패와 만료된 마지막 lease는 5회 한도 뒤 dead가 되며, 수동 재시도는 확인된 진행 위치를 보존한다. 벡터 정리는 페이지별 삭제 확인 후 cursor를 이동하고 전체 순회가 끝나야 erasure 완료 시각을 기록한다. 재등장 방지용 식별자는 남겨 두며, 휴지통의 기억과 영구 제거한 기억 모두 마지막 완료 확인 후 24시간이 지나면 재점검 대상이 된다. 완료 작업의 `available_at`은 마지막 확인 시각이며 유지보수 호출당 원시 후보 최대 100개를 검사한다. 전체 대기량을 하루 안에 처리한다는 보장은 없다. 복원한 기억과 실행 중 lease는 제외한다. 재점검과 명시적 인덱스 재구축은 진행 위치를 초기화한다. 한 작업 조각의 provider 호출 수·시간과 전체 drain 시작 시간을 제한한다.

0010은 로컬 checkout 만료만으로 새 결제를 허용하지 않는다. Stripe에서 이전 세션의 만료 또는 연결 구독의 종료를 확인한 뒤 변경 불가한 기록을 남긴다. 결제 완료 이벤트가 아직 처리 중이면 새 구독을 만들지 않고 재조정한다. 응답 유실로 이전 session ID를 모르는 경우에도 결제가 없었다고 추정하지 않고 운영자 재조정 전까지 차단한다. SCIM DELETE는 멤버십을 회수하고 SCIM 조회에서 숨기되 내부 이력은 보존하며, PATCH 비활성화는 active=false로 조회된다. GET의 페이지 인수와 attributes/excludedAttributes도 규약에 맞게 처리한다.

0011은 Space별 export 이력, 기억 생성 시각 정렬, 수신 초대 페이지를 위한 인덱스다. export는 페이지 대상 ID를 먼저 제한한 뒤 해당 revision을 읽는다. 수신 초대는 기본 25개, 최대 100개씩 계정에 귀속된 cursor로 조회한다. live 기억의 이전 revision 벡터도 마지막 완료 확인 후 24시간부터 재점검 대상으로 삼되 이미 완료한 embedding 조각은 재호출하지 않는다.

0012는 FTS의 고정 행 식별자 표를 만들고 현재 live 기억으로 파생 검색 내용을 재구축한다. 인증 view도 해당 credential의 정확한 멤버십을 조회하도록 교체한다. 원본·이력·감사·멤버십·credential 행은 보존한다. 이관 시 한 번 실행되는 FTS 재구축 시간은 실제 DB 크기로 staging에서 확인한다. 이후 기억 수정은 인덱스로 해당 FTS 행만 찾는다. 행 식별자 표는 휴지통·복원·영구 제거 후에도 유지한다.

0013은 foundation key 발급에서도 정확한 멤버십만 조회하도록 적용한다. 기존 권한 검사와 멤버십·이메일 연결, 발급 metadata와 감사 기록은 유지한다.

0014는 원문과 이력, FTS 행 ID를 보존하면서 파생 검색 인덱스를 재구축한다. Space 식별자와 1–31자 접두어 인덱스를 사용하며, 처리할 검색 단어가 31자를 넘으면 사용량 차감 전에 `search_token_too_long`을 반환한다. 순위는 해당 Space의 본문 일치 밀도를 사용한다. 접두어 인덱스가 D1 물리 용량을 추가로 사용하므로 본문·이력 논리 quota만 보고 여유 공간을 판단하지 않는다. 데이터가 있는 staging 사본에서 용량과 migration 시간을 측정한다. 작업 큐의 상태별 조회 인덱스, cleanup-only 표시와 유지보수 cursor도 추가하며 기존 작업 진행 위치는 보존한다.

0015는 초기 작업공간·키 조회의 계정·조직 후보 인덱스와 본문 제거용 tombstone 인덱스·cursor를 추가한다. 자동 본문 제거를 활성화하면 호출당 원시 대상 20개를 검사하고 각 Space의 보존 기간을 적용한다. 아직 시기가 되지 않은 행도 cursor를 진행한 뒤 다음 순회에서 다시 검사하므로, 보존 기간은 삭제 가능 시점이며 정확한 삭제 완료 시각을 보장하지 않는다. 대기량과 가장 오래된 미처리 항목을 함께 감시한다.

0016은 Space별 ingest/job 목록과 전체 보존 상태를 포함한 재구축 조회용 인덱스를 추가한다. 공급자가 접수한 벡터 삭제의 최대 100개 ID를 저장하고, 반영 대기 중에는 5초 뒤 확인을 이어간다. 정상 반영 대기는 기존 실패 횟수를 보존하고, 실제 공급자 오류·버려진 lease는 5회 제한을 유지한다. 삭제 확인과 cursor는 현재 lease에서 부재를 확인한 뒤에만 갱신한다.

0017은 대기 페이지의 재삭제 시각과 간격을 저장한다. 첫 60초 동안은 반영 여부만 확인하고, 계속 존재하는 ID는 같은 페이지를 다시 삭제한다. 재시도 간격은 2배씩 늘려 최대 24시간으로 제한한다. 공급자 호출 전에 진행 상태를 저장하므로 재시작해도 대기 시간이 초기화되지 않는다. 늦게 끝난 이전 upsert 때문에 생긴 벡터도 이 경로에서 정리하며, 실제 부재를 확인하기 전까지 완료로 처리하지 않는다.

`vector_erased_at`은 마지막으로 부재를 확인한 시각이다. 재점검이 pending 상태가 되더라도 그 과거 확인 기록은 보존한다. 이전 공급자 요청이 나중에 끝나지 않는다는 보장은 아니므로 pending/dead 정리 작업과 함께 확인한다. 최초 제거는 실제 부재를 확인할 때까지 이 값이 null이다.

검색어만 NFKC로 바꾸지 않고 저장 본문과 같은 Unicode61 규칙을 사용한다. 전각 문자·합자는 동일한 글자로 검색할 수 있고 ASCII 호환 변형과는 구분된다. 원래 쿼리에서 처리할 서로 다른 단어 최대 20개 각각에 Unicode 31자 제한을 적용한다.

## 생성·위임 응답 복구

조직·Space 생성 POST는 멱등 요청이 아니다. 전송 실패, 성공 응답 본문 유실·해석 실패, 변경 요청의 5xx는 이미 적용된 쓰기 뒤에도 발생할 수 있다. 결과가 불확실하면 `/v1/workspace`를 새로 조회해 기존 ID·이름·조직 및 부모 조직을 확인한 뒤 필요한 경우에만 다시 생성한다. 같은 POST를 자동 재전송하지 않는다. 루트 편집기는 필요한 입력·초안을 복사하고 페이지를 새로고침해 먼저 확인하도록 안내한다. 작업 ID가 있는 메모리 변경의 기존 재시도 동작은 유지한다.

`/manage`의 편집 완료는 자신이 제출한 초안만 정리한다. 이전 응답보다 나중에 작성한 실패 초안은 재시도와 같은 계정의 로그인 복구를 위해 보존하며, 이전 요청이 본문 없는 receipt를 받으면 그 제출본도 별도로 남긴다.

도메인 위임은 정확히 같은 domain ID와 membership ID의 유효한 기존 위임이면 재시도에 `200 {"completed":true}`를 반환한다. 매번 현재 관리자·대상 멤버십·도메인 유효기간과 브라우저 session·최근 메일 proof를 확인한다. 회수된 위임을 되살리거나 재가입한 멤버십으로 기존 위임을 다시 연결하지 않는다.

## 공유 발급 응답 복구

0018은 `release_shares(space_id,created_at DESC,id DESC)`의 `release_shares_space_created` 인덱스로 Space별 발급 이력을 최신순으로 제한 조회한다. 기존 grant와 시각은 보존한다.

`GET /v1/spaces/:spaceId/shares`는 `results,nextCursor`를 반환한다. `limit`은 기본 25, 허용 범위는 정수 1–100이며 `createdAt`, `id` 내림차순이다. 다음 페이지에는 반환된 cursor를 그대로 사용한다. cursor는 조회 계정과 Space에 귀속된다. 각 행은 `id,spaceId,recipientEmail,createdAt,expiresAt,acceptedAt,revokedAt`을 포함한다. 이전 브라우저 session에서 만든 grant와 만료·회수된 이력도 남는다. 이 시각들은 과거 기록이며 현재 수신자의 접근 가능 여부를 보장하지 않는다.

조회에는 현재 브라우저 session과 해당 Space의 현재 update 권한이 필요하다. PAT와 외부 OAuth bearer는 허용하지 않으며, 목록 조회 자체에는 최근 메일 proof가 필요하지 않다. 기존 공유 발급과 DELETE 회수에는 현재 update 권한 및 5분 이내 메일 proof가 계속 필요하다.

공유 POST는 멱등 요청이 아니다. 응답 유실이나 변경 요청의 5xx로 결과가 불확실하면 자동 POST 재시도를 하지 않는다. `/manage`의 보낸 공유 새로고침·추가 페이지에서 원본·중복 grant를 확인한 다음 원하지 않는 grant를 행별 회수 버튼 또는 `DELETE /v1/spaces/:spaceId/shares/:shareId`로 회수한다. DELETE 결과도 불확실하면 같은 ID의 회수 기록을 새로 조회한다. 불확실한 결과를 정리한 뒤 필요한 경우에만 새 grant를 만든다.

확인된 회수는 늦게 도착한 이전 목록 응답으로 되돌리지 않는다. 실제 `revokedAt`을 새로 조회하기 전에는 회수 완료 사실만 표시하며 시각을 만들어 넣지 않는다. 계정·Space 전환 시에는 이전 목록 응답을 계속 차단한다.

## 삭제와 보존

기억 삭제는 tombstone이며 기본 30일 휴지통 정책이다. 복원은 보존 기간 안에서 revision 검사를 통과해야 한다. 명시적 영구 제거는 최근 본인 확인과 정확한 ID 입력을 요구한다. 기억 본문/source/provenance/eventTime과 이전 본문 버전을 지우고, 식별자 중심 erasure ledger로 벡터 정리를 추적한다. 남은 ID, 계정 관계, 작업 fingerprint, 감사 식별자가 개인정보와 완전히 무관하다고 주장하지 않는다.

휴지통의 `restoreUntil`은 `deletedAt + 현재 Space retentionDays × 86400000`이고, `restoreExpired`는 응답 시각이 그 기한 이상인지 나타낸다. 정책 변경은 다음 조회·복원 판단에 반영된다. 두 필드는 보존 기한 정보이며 쓰기 권한이 아니다. 복원은 현재 update 권한과 `expectedRevision`을 별도로 검사한다. 같은 revision의 tombstone이 기한에 도달하면 `409 restore_expired`이고, revision 불일치는 `409 revision_conflict`다.
관리 콘솔은 서버가 기한 만료를 보고한 복원 버튼을 비활성화한다. 목록을 연 뒤 정책이 바뀌어 `restore_expired`가 반환되어도 버전 충돌로 안내하지 않고 복원 기간 만료를 설명한다.

메모리 GET·목록·검색은 최종 primary snapshot에서 현재 read 권한과 반환 revision의 제거 여부·요청한 live/휴지통 상태를 검사한다. 일반 목록·검색은 대체된 기억도 제외한다. export는 과거 snapshot revision을 유지하며 최종 조회에서 현재 export 권한·session과 원본의 영구 제거 여부를 확인한다. 응답 판단 기준은 이 최종 snapshot이다. 목록·export의 원시 페이지에서 일부 항목이 제외되어도 `nextCursor`를 유지하므로 결과가 비어도 cursor가 있으면 계속 조회한다.

벡터 삭제 요청이 수락됐다는 사실과 조회에서 실제 사라진 것은 구분한다. 확인되지 않으면 재시도하며 늦은 upsert가 되살아나는 경우에도 다시 정리한다. cron 중단/공급자 장애가 있으면 물리 제거가 지연될 수 있다. 이미 내보낸 다운로드 파일이나 사용자의 별도 복사본을 이 서비스에서 회수할 수는 없다.

임시 대화 원문은 서버 관리 키로 AES-GCM 암호화되고 AAD에 작업 ID를 사용한다. 승인/취소 때 즉시 제거하고, 미처리 원문은 24시간 만료 후 유지보수에서 정리한다. 만료 제안은 API에서 숨기므로 정리 지연이 열람 허용 기간을 늘리지 않는다. 키에 버전별 복호화 keyring은 없으므로 회전 전에 해당 키로 암호화된 작업을 처리하거나 취소해야 한다. keyring 기반 무중단 key rotation은 추가 작업이다.

ingest 상세·목록은 현재 권한과 작업 상태를 같은 최종 primary snapshot에서 읽고 반환 시 만료도 확인한다. `approved`·`cancelled` 상태는 기한 뒤에도 유지하고, 나머지 만료 작업은 `expired`로 표시한다. 만료되지 않은 `review` 상태에서만 제안·인용문을 반환하며 승인·취소·만료 응답에 이전 제안을 포함하지 않는다.
관리 콘솔도 승인·취소 중 목록을 새로고침한 경우 현재 카드와 늦게 도착한 상세 응답에 최종 상태를 반영한다. 완료한 작업의 이전 인용문과 승인·취소 버튼을 다시 표시하지 않으며, 다른 계정·Space로 전환한 화면에는 이전 결과를 채우지 않는다. 루트의 일회용 코드 발급 창은 응답 처리 중 닫기·취소·Escape를 잠그고 결과 또는 오류가 표시된 뒤 해제한다.

기억 제거 응답은 `status: access_removed_cleanup_pending`, `accessRemoved: true`, `payloadCleanup: not_confirmed`, `indexCleanup: not_confirmed`를 반환한다. 이는 중앙 접근 차단의 작업 영수증이며 물리적 정리 완료 확인이 아니다. R2·hot D1 원문과 벡터는 정리 작업이 성공할 때까지 남을 수 있다. 같은 작업을 재시도해 받은 영수증도 최신 정리 상태를 조회한 결과가 아니다. 관리 콘솔은 이를 접근 차단 및 정리 확인 대기로 표시한다.

**백업 안의 과거 본문, 계정/이메일/결제 전체 개인정보는 이 개별 기억 제거 API의 완료 범위가 아니다.** 전역 탈퇴·삭제 정책을 별도로 확정하고 구현해야 한다.

## 복구 훈련

출시 전에 다음 순서를 staging에서 실제 수행한다.

1. 중앙 D1 일반 테이블/DDL, 모든 active/draining HOT 자료와 tombstone, R2 객체·metadata/hash, 현재 schema와 source hash, snapshot 이후 권한 회수/erasure 증거를 기록한다. 쓰기·진행 중 provider 작업을 통제한 capture 경계를 확인하고 비공개로 보관한다.
2. 새 격리 DB에 복구한다. 외부 트래픽은 닫고 모든 이전 key/session을 유효한 것으로 가정하지 않는다.
3. snapshot 이후 발생한 계정/이메일/멤버십 회수와 영구 제거를 재적용한다. 이를 재구성할 자료가 없으면 복구본을 사용자에게 노출하지 않는다.
4. 새 인덱스로 canonical 데이터에서 재구축하고 제거된 기억·다른 tenant 결과가 안 나오는지 검사한다. 오래된 인덱스만 연결해서 복구하지 않는다.
5. 개수·revision·삭제·공유·권한·검색 샘플과 현재 provider 상태를 확인하고 승인 후 승격한다. 결과와 실패를 기록한다.

실제 provider의 전체 D1 export는 FTS virtual table 때문에 거절되었다. 명시적 일반 테이블 export와 별도 DDL/파생 FTS 재구축 exporter는 native 검증 중이다. 도구의 파일 검증이나 native 성공만으로 원격 capture·복구 성공을 주장하지 않는다. [MULTI_STORE_RECOVERY.md](MULTI_STORE_RECOVERY.md)의 현재 source/config/schema에 맞는 격리 훈련을 완료한다. 자동 원자적 다중 저장소 snapshot이나 전체 restore orchestrator가 제공되는 것은 아니다.

## 외부 회수 이벤트 계약

`POST /webhooks/identity`, raw UTF-8 JSON. 헤더:

```
x-memory-timestamp: UNIX_SECONDS
x-memory-signature: lowercase_hex(HMAC_SHA256(secret, timestamp + "." + raw_body))
```

시간 허용 오차는 300초, event ID는 고유해야 한다. 같은 ID/같은 raw body 재전송은 허용하고 다른 body는 충돌이다. raw body를 서명 후 재직렬화하지 않는다. secret은 최소 32문자이며 충분한 난수로 만든다.

```json
{"id":"event-unique-id","issuer":"https://auth-api.allen.company","subject":"provider-subject","type":"email.revoked","email":"person@example.com"}
```

위 형식은 기존 v1의 영구 회수 계약이다. 계정 비활성화는 `type=account.disabled`이며 기존 차단을 되살리지 않는다. email 회수는 Memory claim에 적용하고 mailbox를 삭제하지 않는다. 조직 SCIM은 정확한 멤버십을 회수하며 개인 계정을 삭제하지 않는다.

0024의 v2 lifecycle은 중앙의 불변 event ID/sequence와 계정 또는 정확한 이메일별 순서 상태를 사용한다. 계정 suspension은 기존 credential·멤버십·proof를 회수하고 resume은 새 SSO를 요구하며 옛 권한을 복원하지 않는다. 이메일 재검증은 새 claim을 허용하되 옛 ACL은 복원하지 않는다. 계정 삭제는 terminal이다. 검증된 Memory audience JWT의 최신 lifecycle event를 새 claim 생성 전에 적용하므로 정상적인 새 owner가 늦은 동일 HMAC 전달에 의해 회수되지 않는다.

중앙 private publisher는 동일 D1 변경의 outbox, 환경별 HMAC secret, 제한된 무기한 재시도와 정확한 production/`memory-staging.allenlabs.org` 목적지를 구현했다. Native 두 Worker에서 9 events/11 deliveries를 검증했지만 중앙에는 아직 배포하지 않았다. 실제 전달 목표 2분 미만은 배포 후 oldest pending age로 계측해야 한다. 동기식 cross-service 회수나 발행 전 과거 삭제 기록의 자동 복원을 주장하지 않는다.

개인 Space의 소유 계정이 suspended이면 기존 보낸 공유의 열람·수락과 새 AI/provider 처리를 차단한다. 명시적인 resume은 보존된 보낸 공유를 다시 사용할 수 있게 하지만 회수된 수신자 이메일 claim, 기존 session/PAT, 조직 멤버십을 복원하지 않는다. 조직 자료는 과거 작성자의 개인 계정 상태가 아니라 해당 조직의 현재 권한으로 판단한다.

## 관측성

선택적 Analytics Engine에는 제한된 route 분류, 메서드, HTTP 상태, 지연과 개수만 보낸다. URL query, OAuth code, body, 이메일, token, account ID는 넣지 않는다. 원본 request/invocation logging은 비활성 상태를 유지한다. 원문을 알 수 없는 상태 코드 집계만으로 모든 장애가 설명되지는 않으므로 승인된 진단 절차를 따로 정한다.

권장 점검은 `/ready` heartbeat, queue pending/dead/현재 episode age, provider 오류율·월별 예약, 중앙/HOT 물리 용량, R2 비용, pool quota 거절, purge/retirement backlog, lifecycle oldest pending age와 도메인 만료다. 결제는 이번 범위에서 비활성이다. 실제 pager/alert destination 연결과 대응 훈련은 별도 gate다.

`/ready`의 기술 설정 통과와 GA 승인을 구분한다. `LIVE_ACCEPTANCE_ID`만으로 승인되지 않으며 정확한 source/config/중앙25/HOT1과 15개 gate 증거를 묶은 Ed25519 JWS가 필요하다. 최종 메일 proof, lifecycle 배포, 부하·비용·복구와 운영 정책의 증거가 갖춰진 뒤 [GA 수락](GA_ACCEPTANCE.md)을 수행한다.
