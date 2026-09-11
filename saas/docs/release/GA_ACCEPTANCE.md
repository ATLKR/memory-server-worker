# 초대 기반·사용량 계량 GA 수락 절차

선택한 범위는 초대 기반 가입, 관리형 메모리, AI 검색·검토형 추출, 사용량 계량이다. 유료 결제는 제외한다. 이 문서는 실행 절차이며 배포나 실환경 수락 완료 기록이 아니다. 기록된 기존 production rc.3/schema 1–7과 새 소스의 배포 상태는 [통합 기록](INTEGRATION.md)에서 구분한다.

## 대상과 비용 통제

별도 staging Worker·도메인·중앙 D1·두 개 이상의 HOT D1·비공개 R2·Vectorize index·Analytics dataset을 실제로 준비한다. 중앙 인증은 `auth-api.allen.company`를 사용하며, 선택한 origin의 정확한 callback을 등록한다. staging 설정 파일은 실제 리소스 정보를 넣은 뒤 저장한다. 아직 생성하지 않은 리소스를 생성 완료로 기입하지 않는다.

설정은 `DEPLOYMENT_ENVIRONMENT=staging|production`, `GA_PROFILE=managed-ai-metered`, `ENROLLMENT_MODE=invite`, `PAID_BILLING_ENABLED=false`를 명시한다. `AI_MONTHLY_BUDGET_MICROUSD`는 양의 정수 문자열이며 production 상한은 `20000000`($20), staging은 `200000`($0.20)이다. 이는 보수적인 AI 호출 예약 예산이다. 사용자가 정한 Memory Cloudflare 전체 월 $50 한도를 자동 보장하지 않는다. Workers·D1·R2·Vectorize·로그 비용도 별도 계정 예산 경보와 실제 청구 확인으로 관리한다. 가격 변화나 트래픽 증가 시 호출을 중단할 운영 책임자를 정한다.

`ENROLLMENT_EMAIL_HASHES_JSON`은 소문자 SHA-256 배열(최대 200개)인 secret으로 관리한다. 누락 또는 빈 배열은 새 가입을 닫으며 기존 활성 사용자를 자동 탈퇴시키지 않는다. 원문 이메일을 공개 설정이나 증거 요약에 적지 않는다.

`STORAGE_SHARDS_JSON`의 각 항목은 정확히 `{id,binding,mode}`이며 mode는 `active` 또는 `draining`이다. D1 실제 ID는 중앙 DB를 포함해 모두 달라야 한다. `DB.migrations_dir`는 `migrations`, 모든 HOT binding은 `shard-migrations`를 사용한다. `MEMORY_PAYLOADS` binding 존재만으로 R2의 외부 공개 여부를 증명할 수 없으므로 Cloudflare의 managed/custom public domain 설정도 확인한다.

## 배포 명령

다음 예시는 `saas/`에서 실행한다. `wrangler.staging.jsonc`는 운영자가 실제 대상 정보로 준비한 파일이다. `--env`는 지원하지 않는다. 인수를 생략한 기존 npm 명령은 production 설정을 사용하므로 staging에서는 항상 `--config`를 쓴다.

```powershell
npm run preflight -- --config .\wrangler.staging.jsonc
npm run build -- --config .\wrangler.staging.jsonc
npm run db:remote -- --config .\wrangler.staging.jsonc
npm run deploy -- --config .\wrangler.staging.jsonc
```

원격 migration 전 백업·복구 지점과 대상 리소스 목록을 확인한다. migration 명령은 active/draining HOT 전체를 먼저 적용하고 중앙 DB를 마지막에 적용한다. 실패하면 후속 DB를 실행하지 않는다. deploy는 깨끗한 Git 소스를 요구하고 전체 `npm run check`를 통과한 뒤 같은 대상을 다시 확인한다. 현재 Git commit과 canonical 설정 지문은 Wrangler define으로 번들에 고정한다. 변경 중인 소스의 dry-run은 `unreleased`이며 GA 증거로 사용할 수 없다.

## 필수 실환경 증거

아래 ID는 코드의 필수 목록과 일치한다. 아직 수행하지 않은 항목은 `pending`으로 남긴다. 외부 전체 SCIM/SAML, Zero-Access, 개인용 엔진과 완전한 품질 동등성, 유료 결제는 이 GA 범위의 완료 조건이 아니다.

| Gate ID | 실제로 확인할 결과 |
|---|---|
| `source-validation` | 같은 commit의 전체 검사·CI·데이터 보유 schema 1–25 업그레이드·native D1와 HOT schema 1 검증 |
| `sso-session` | 실제 로그인, 만료·재접속·로그아웃과 계정 전환 |
| `mail-proof` | 실제 수신함에서 proof 수신·소비, 만료·다른 세션 재사용 거부 |
| `workspace-authority` | 두 계정의 Space 분리, 조직 권한 비상속, membership·domain lease·관리자 회수 |
| `identity-revocation` | 중앙 회수 이벤트 발행·서명 수신, 지연·중복·누락 재전송 및 재조정 |
| `pat-mcp-clients` | 명시적 Space/PAT scope·회수와 실제 지원 MCP 클라이언트 연결; Claude SSO callback 호환성은 별도 확인하며 현재 지원 PAT 경로를 시험 |
| `ai-retrieval` | 실제 AI/Vectorize 차원·namespace·색인 지연, 권한 재검사, 공급자 실패, 질의 품질 |
| `reviewed-ingestion` | 암호화된 임시 원문, 실제 추출·인용 검토·선택 승인·취소·만료 |
| `sharing-export-erasure` | 수락 기반 공유, 응답 유실 후 발신 목록 복구/회수, export watermark, 제거와 외부 tombstone 확인 |
| `metering-quotas` | 재시도 중복 계량 방지, pool/논리 저장량, quota·rate limit·AI 예약 예산 거부, 유료 endpoint 비활성 |
| `physical-storage` | 실제 CF 배포 binding/리소스 ID를 설정과 대조, 두 HOT 경로, R2 복구 읽기·비공개 여부·무결성 |
| `multi-store-recovery` | 격리된 staging의 중앙/HOT/R2 복구, 회수·erasure 재적용, 색인 재구축, 기록한 RPO/RTO 결과 |
| `load-capacity` | 운영자가 정한 동시성·지연·대기열·용량·비용 기준으로 실제 유한 부하 시험 |
| `observability-response` | 개인정보 없는 집계, heartbeat/queue/dead-letter/용량/예산 경보, 실제 경보 전달·담당자 대응 |
| `operational-policy` | 초대 roster 운영, $50 전체 월 예산 대응, 지원·장애 공지·보존·탈퇴/개인정보 삭제 처리 책임과 사용자 안내 |

## 비공개 기록 생성과 서명

Ed25519 개인 키와 모든 수락 기록은 공개 저장소 밖의 접근 제한 디렉터리에 보관한다. 해당 공개 키의 SPKI PEM을 대상의 `LIVE_ACCEPTANCE_PUBLIC_KEY`에 설정하고, 이를 포함한 검증 소스를 먼저 확정한다. 개인 키를 Wrangler 설정, 명령 인수 또는 Git에 넣지 않는다.

```powershell
$acceptanceDir = 'C:\Private\MemoryAcceptance' # 운영자가 준비한 비공개 디렉터리
node --experimental-strip-types scripts/acceptance-record.mjs template --config .\wrangler.staging.jsonc --out "$acceptanceDir\record.json"
```

template은 현재 source/schema/설정 지문을 기록하지만 모든 gate를 `pending`으로 만든다. ID를 고유한 운영 기록 ID로 바꾼다. 검증을 수행한 뒤 각 gate에 `status: "passed"`, Unix 초 단위 `completedAt`, 기록 파일 기준 상대/절대 `evidenceFile`, 비공개 증거 위치를 설명하는 `evidenceRef`, 실제 파일의 `evidenceSha256`을 기입한다. 변경된 소스나 대상에서 예전 template을 재사용하지 않는다.

각 evidence 파일은 최대 1 MiB JSON이다. `format: 1`, 해당 `gate`, `outcome: "passed"`, `observedAt`, 그리고 record와 동일한 `releaseVersion`, `sourceRevision`, `environment`, `origin`, `centralSchemaVersion`, `hotSchemaVersion`, `resourceFingerprint`를 포함한다. `checks`에는 이름과 `outcome: "passed"`가 있는 실제 관찰 결과를 하나 이상 기록한다. 원본 로그·사용자 동의·복구 결과는 비공개 evidence에서 참조한다. 일반 로그를 자동으로 성공 판정하거나 수동 판단을 자동 시험으로 표현하지 않는다.

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath "$acceptanceDir\sso-session.json").Hash.ToLowerInvariant()
# 모든 gate의 실제 증거를 검토한 후, 명시적인 UTC 만료 시각을 넣는다.
Get-Content -Raw -LiteralPath "$acceptanceDir\operator-private.pem" | node --experimental-strip-types scripts/acceptance-record.mjs sign --config .\wrangler.staging.jsonc --record "$acceptanceDir\record.json" --out "$acceptanceDir\acceptance.jws" --expires-at 2026-09-17T00:00:00Z --key-stdin
```

예시 날짜를 그대로 재사용하지 않는다. 만료는 현재 시각과 **가장 오래된 gate 관찰 시각으로부터 7일 이내**여야 한다. 환경변수 `MEMORY_ACCEPTANCE_PRIVATE_KEY`도 지원하지만 stdin과 동시에 사용하지 않는다. 도구는 실제 증거 해시·모든 check 결과·대상 일치·서명 키를 검증하며, 기존 output을 덮어쓰지 않는다. 서명된 JWS와 공개 키를 해당 배포에 설치하는 단계는 별도 운영 변경이다. 이 도구는 네트워크 시험, secret 설치, 배포 또는 GA 승격을 수행하지 않는다.

`LIVE_ACCEPTANCE_ID` 문자열만으로는 승인되지 않는다. `/ready`는 번들의 source/리소스 지문과 일치하는 서명, current schema·HOT/R2 검사·heartbeat·필수 binding·초대 설정·AI 예산을 확인한다. 같은 source/config에서 `pilot`→`ga`만 바꾸는 승격은 서명을 무효화하지 않는다. 같은 source에서 표시용 `PRODUCT_NAME`, `PRODUCT_SHORT_NAME`, `PRODUCT_DESCRIPTION`, `PRODUCT_ACCENT_COLOR`만 바꾸어도 리소스 지문은 유지된다. 지원 연락처·인증 client·origin·예산·샤드는 계속 지문에 포함되며, source 또는 주요 리소스·정책 변경은 새 검증과 서명이 필요하다. `/ready`에는 안전한 기록 ID와 boolean만 나오며 비공개 evidence는 나오지 않는다. `/health`의 `build`는 실제 번들에 고정된 `sourceRevision`, `resourceFingerprint` 해시와 `payloadFormat`을 반환한다. 이는 배포 대상 확인용이며 원문 리소스 ID나 비밀 값을 포함하지 않는다. 관리 화면에서 바뀐 실제 binding은 별도로 대조해야 한다.

## 운영상 남는 범위

Worker binding에는 실제 CF UUID를 조회하는 인터페이스가 없다. 수락 담당자는 서명 전에 CF 배포 설정·DB/Vectorize/R2/Analytics ID·R2 공개 설정을 독립적으로 대조해야 한다. 이후 관리 UI에서 설정을 바꾸면 기존 번들만으로 모든 외부 변경을 즉시 감지할 수 없다. 짧은 증거 만료와 변경 절차를 함께 적용한다.

자동 live 시나리오 실행기·CF binding 대조 수집기·전체 외부 백업/restore orchestrator·실제 pager 연결은 이 서명 도구가 제공하지 않는다. [운영 절차](OPERATIONS.ko.md)에 따라 실행·증거 수집 책임을 정한다. 서비스 수준, RPO/RTO, 지원 연락처, 보존·탈퇴/전체 개인정보 삭제 방식은 실제 운영 결정과 이행 증거가 필요하다. 서명은 운영자 수락 기록이며 제3자 인증이나 법규 준수 보증이 아니다.

## 런타임 암호화 키 복구

임시 ingestion 암호문은 AES-GCM v2 envelope에 공개 키 식별자를 포함한다. 기존 두 부분 envelope도 동일한 기존 키로 읽을 수 있지만, 키 식별자가 과거 암호문을 복호화하거나 분실한 키를 대체하지는 않는다.

기존 키를 사용할 수 없어 교체한다면 먼저 해당 환경의 암호문 보유 여부와 실행 중 ingestion을 확인한다. 새 ingestion 저장을 일시 중지하고, 저장된 암호문이 0개임을 다시 확인한 뒤 새 키와 정확히 일치하는 영구 DB guard를 설치한다. guard는 release_ingests의 INSERT/UPDATE와 release_jobs의 ingestion lease claim을 모두 검사해야 한다. 그래야 교체 후 늦게 도착한 이전 Worker가 옛 키로 저장하거나 새 작업의 재시도 횟수를 소진하지 않는다. 새 코드와 키의 실제 설치, 빌드 식별자, binding, readiness, 새 키의 저장·추출을 확인한다. 일시 중지 guard를 제거한 뒤에도 키 guard는 유지하고 NULL 처리에 의한 취소·만료·삭제를 허용한다. 불확실한 쓰기는 재시도하지 말고 보존한 intent와 현재 provider 상태로 조정한다.

백업에는 당시의 키 guard가 그대로 포함된다. 격리 복구 후에는 과거 guard와 일치하는 escrow 키를 사용하거나, 별도로 검증한 교체 절차를 거쳐야 한다. schema 버전만으로 키 복구 또는 운영 승격이 완료되었다고 판단하지 않는다. 키 값은 별도 비밀 저장소에 보관하고 읽어 되돌려 대조하며, Git·운영 로그·명령 인수에 넣지 않는다.
