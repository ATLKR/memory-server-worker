# 중앙 D1·HOT·R2 격리 복구

이 절차는 [GA 수락](GA_ACCEPTANCE.md)의 `multi-store-recovery` gate에 제출할 자료를 준비한다. `scripts/recovery-cli.mjs`는 운영자가 수집한 파일을 읽어 SHA-256 manifest와 격리 복구 계획을 만든다. Cloudflare 접근, SQL 실행, bucket 쓰기, secret 설치, 배포 또는 승격은 하지 않는다. `verified`는 제공된 파일·설정·구조의 검증이며 실제 복구 성공이나 백업 완전성의 provider 보증이 아니다.

## 보존해야 할 계약

- 중앙 DB가 권한·현재 revision·발행·사용량의 기준이다. HOT는 본문/FTS 데이터이고 R2는 `payload/v1/<payloadId>`의 canonical JSON `{body,provenance,source}`를 보관한다. R2 원문과 SQL export에는 개인정보가 있으므로 bundle·manifest·증거 모두 공개 저장소 밖에 보관한다.
- R2 metadata는 정확히 `payloadId,shardId,spaceId,memoryId,sha256,state`다. `state=purged`는 원래 SHA/context를 유지하는 **영구 0바이트 객체**다. HOT의 `payload_tombstones`도 영구 보존하며 늦은 재삽입을 막는다. 오래된 백업으로 살아 있는 R2를 덮어쓰지 않는다.
- `release_payload_purges`의 미완료 작업, erasure ledger, HOT tombstone과 백업 이후의 회수·삭제 증거를 합쳐야 한다. 오래된 본문을 먼저 공개하고 나중에 삭제하는 순서는 허용되지 않는다. 아래 두 capture 방식 중 증명 가능한 방식을 명시하고, 그 시점 이후 작업을 별도 증거로 대조한다.
- 오래된 중앙 DB를 복원하면 이미 회수한 credential·멤버십·공유·domain lease가 되살아날 수 있다. 외부 접근을 막은 채 복원하고, session/PAT/SCIM key·미사용 proof·pending invitation을 무효화한 뒤 현재 중앙 identity의 revoke/disable/email 상태, 명시적 Space 권한, 공유·domain 권한을 다시 확인한다. 불변 receipt·이미 소비된 proof·audit 기록을 삭제하여 이 문제를 숨기지 않는다.
- HOT export는 보존·비교 자료다. 복구 시 오래된 HOT를 그대로 서비스하지 않는다. 영구 tombstone을 먼저 반영하고, **재조정한 중앙의 현재 유효 head와 검증된 R2**로 HOT/FTS를 재구축한다. trash·history의 cold-only 참조는 R2에 보존하고 현재 검색 head로 승격하지 않는다. Vectorize도 재조정한 권한과 revision으로 다시 만든다.

## Capture와 입력 형식

기존 **정지 capture**는 서비스 쓰기·백그라운드 provider 작업을 차단하고 이미 실행 중인 작업의 종료/결과를 실제로 확인한 경우다. `writesStopped:true`와 operator evidence를 사용한다. 임시 503 Worker와 짧은 대기만으로 기존 HTTP가 모두 끝났다고 표시하지 않는다. Cloudflare는 연결된 HTTP 요청의 wall time에 일률적인 상한을 두지 않는다. [Workers 실행 제한](https://developers.cloudflare.com/workers/platform/limits/)

**`immutable-historical-cut-v1`**은 정지·배출을 주장하지 않는 별도 방식이다. 중앙/모든 HOT의 primary D1 bookmark를 전체 조회·export·metadata 수집 전후에 읽어 각각 같음을 확인한다. 그 구간 안에서 R2를 두 번 완전히 순회하고 정렬된 key/size/ETag/여섯 metadata가 정확히 같아야 한다. 사이에 내려받은 각 객체의 실제 bytes·SHA-256·ETag를 확인하며, 다운로드 metadata의 근거는 두 번 일치한 전체 listing이다. REST GET이 metadata를 제공했다고 꾸미지 않는다. 첫 순회가 끝난 시각을 `consistentAtCut`으로 기록한다. bookmark 변화, 페이지 종료 불명확, 객체 추가·덮어쓰기·삭제·metadata 변화가 관찰되면 캡처를 실패 처리하고 새 구간에서 다시 시작한다. [D1 bookmark](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/), [R2 일관성](https://developers.cloudflare.com/r2/reference/consistency/)

이 논증은 앱의 `없음 → 불변 payload → 영구 purged` 전이와 객체를 지우거나 되살리지 않는 writer 계약에 의존한다. 실제 Worker content의 module SHA, version 전체 목록, binding/vars, bucket 생성 시각과 전후 lifecycle 설정을 조회하여 사전에 검토한 성공 배포 receipt·source SHA·`payloads.ts` hash 이력과 맞춘다. 활성 multipart-upload 만료 외 객체 삭제·storage transition 규칙은 지원하지 않는다. 다른 Worker의 해당 bucket binding도 조사한다. coordinator는 실제 writer inventory를 근거로 최대 한 시간의 구간 동안 별도 관리자/S3 쓰기·배포·lifecycle 변경을 하지 않는다는 운영 전제를 기록한다. API 조회가 모든 전역 credential의 부재를 증명한다는 뜻이 아니다. 검토하지 않은 과거 writer나 누락된 배포 증거가 있으면 이 방식으로 성공 처리하지 않는다. [Worker version 목록](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/), [bucket lifecycle](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/)

새 방식은 `capture:{mode:"immutable-historical-cut-v1",writesStopped:false,providersDrained:null,inventoryComplete:true,consistentAtCut:<epoch ms>,evidenceRef:"capture-evidence.json",evidenceSha256:<실제 SHA>}`를 쓴다. format 2 증거에는 위 관찰·페이지 종료·download/export 해시와 `reconciliation.json`의 해시/길이가 들어간다. 공개 prepare/verify는 두 sidecar도 manifest 파일 목록에 포함해 검증한다. 로컬 검증은 제공된 관찰의 결합·일관성 검사이며, provider 사실의 독립 인증은 아니다. 공개 CLI는 캡처 API를 호출하지 않는다. 실제 collector는 이 계약을 만족하는 별도 운영 도구다.

새 방식에서도 중앙의 현재/history/trash/stage locator, 전체 intent·retirement·purge, erasure, ordered lifecycle event/head/receipt/proof와 두 temporal trigger의 정확한 DDL/hash, 영구 provider/email/domain revocation 자료를 모두 보존한다. 격리 복원에서는 credential·membership 무효화 후 **모든 미발행 intent**를 durable purge-pending으로 전환한다. 늦게 끝난 준비 작업이 새 credential로 발행되면 안 된다. source는 확정된 과거 cut 이후 계속 동작할 수 있지만, 승격 전에 그 이후의 회수·삭제와 최신 identity 증거를 다시 반영해야 한다. 과거 cut 자체를 현재 권한으로 취급하지 않는다.

도구는 현재 checkout의 source SHA, 서비스 버전, migration 디렉터리의 중앙/HOT 최신 schema, 명시한 배포 설정의 fingerprint와 inventory context가 정확히 일치해야 실행된다. 깨끗한 해당 release checkout에서 실행한다. 현재 schema보다 오래되거나 inline/pre-sharding인 자료는 이 경로로 사용할 수 없다. 별도 offline upgrade·재조정·새 capture를 거쳐야 하며 production에 직접 복원하지 않는다.

`inventory.json`과 모든 상대 파일을 같은 비공개 bundle 디렉터리에 둔다. 다음은 **형식 예시**다. SHA·시각·ID는 실제 capture에서 얻으며 placeholder를 수락 자료로 사용하지 않는다.

```json
{
  "format": 1,
  "context": {
    "releaseVersion": "실제 SERVICE_VERSION",
    "sourceRevision": "실제 40자리 git SHA",
    "environment": "staging",
    "origin": "실제 PUBLIC_ORIGIN",
    "resourceFingerprint": "deploymentFingerprint(config)의 64자리 SHA256",
    "centralSchemaVersion": 25,
    "hotSchemaVersion": 1
  },
  "capturedAt": 1800000000000,
  "capture": { "writesStopped": true, "inventoryComplete": true, "evidenceRef": "비공개 capture 기록 ID" },
  "exports": [
    { "binding": "DB", "file": "central.sql" },
    { "binding": "HOT_A", "file": "hot-a.sql" },
    { "binding": "HOT_B", "file": "hot-b.sql" }
  ],
  "objects": [],
  "currentHeads": [],
  "hotTombstones": [],
  "pendingPurges": []
}
```

실제 DB에서 `release_meta.version`, 각 HOT의 `payload_meta.version`을 조회해 source migration과 대조한다. source context의 fingerprint는 `scripts/deployment-config.mjs`의 `loadDeploymentConfiguration({configPath: ...})`와 `deploymentFingerprint(target.config)`로 계산한다. source SHA는 `git rev-parse HEAD`다. 빈 배열은 실제 해당 자료가 없는 capture에서만 사용한다.

| 필드 | 실제 수집·변환할 자료 |
|---|---|
| `exports` | `DB`와 registry의 모든 HOT binding에 대한 비어 있지 않은 provider export. 파일을 실행하지 않고 스트리밍 해시한다. |
| `objects[]` | `{key,file,metadata}`. `key=payload/v1/<payloadId>`, file은 내려받은 **원본 bytes**의 상대 경로. metadata는 위 여섯 필드 그대로이며 purged 파일도 길이 0으로 만든다. payload의 실제 bytes SHA와 canonical JSON을 검증한다. |
| `currentHeads[]` | `{spaceId,memoryId,revision,payload:{id,shardId,objectKey,sha256,bytes}}`. 중앙 `memories`의 HOT 재구축 대상인 현재 live head(`deleted_at IS NULL AND erased_at IS NULL`)를 수집한다. `[external]` placeholder를 본문으로 취급하지 않는다. |
| `hotTombstones[]` | 각 HOT의 모든 `payload_tombstones`를 `{payloadId,shardId,spaceId,memoryId,retiredAt}`로 변환한다. |
| `pendingPurges[]` | 중앙 `release_payload_purges` 중 `purged_at IS NULL`을 `{spaceId,memoryId,payload:{id,shardId,objectKey,sha256,bytes}}`로 변환한다. 아직 R2에 없는 intent도 버리지 않는다. |

중앙 export와 구조화 inventory의 일치를 자동 SQL 분석으로 증명하지 않는다. `schema-inventory-consistency` 증거에 모든 중앙 현재/history/trash/stage locator, R2 inventory, HOT tombstone, pending purge의 대조 결과와 count를 남긴다. history/trash 참조가 R2에 존재하는지도 확인한다. manifest 준비 중 파일을 변경하지 않는다.

단일 bundle 제한은 JSON 32 MiB, 선택한 설정 1 MiB, export 하나 256 MiB, 합계 2 GiB, objects/heads/tombstones/purges 각 10,000개다. 객체 하나는 실제 payload 계약인 131,072 bytes 이하다. 이 한도를 넘는 운영 데이터는 이 도구의 완전한 단일 bundle 범위를 벗어난다. 일부만 내보내고 `inventoryComplete=true`로 표시하지 않는다. 분할 snapshot 수집·합산 검증기는 별도 구현/수락이 필요하다. 상대 경로에는 ASCII 영숫자·`_-.`·`/`만 허용하며 traversal·절대 경로·Windows stream·symlink/junction은 거부한다.

## 준비·검증·격리 계획 명령

Node 24에서 `saas/`를 작업 디렉터리로 사용한다. source/destination은 실제 리소스로 작성한 독립 설정이며 기본 production fallback이 없다. `--env`나 임의 provider 인수는 지원하지 않는다.

```powershell
node --experimental-strip-types scripts/recovery-cli.mjs prepare --config C:\private\source.jsonc --inventory C:\private\capture\inventory.json --out C:\private\capture\manifest.json
node --experimental-strip-types scripts/recovery-cli.mjs verify --config C:\private\source.jsonc --manifest C:\private\capture\manifest.json --sha256 CAPTURE때_별도보관한_64자리SHA256
node --experimental-strip-types scripts/recovery-cli.mjs drill-plan --config C:\private\source.jsonc --manifest C:\private\capture\manifest.json --sha256 CAPTURE때_별도보관한_64자리SHA256 --destination C:\private\quarantine.jsonc --quarantine --out C:\private\drill-plan.json
```

prepare가 출력한 manifest SHA-256은 bundle과 별도로 보관한다. 검증 직전에 같은 bundle에서 해시를 다시 계산해 기대값으로 쓰면 manifest 변조 탐지가 무의미해진다. 도구는 서명·암호화를 대신하지 않는다. 출력은 완성된 임시 파일을 원자적으로 설치하고 기존 파일을 덮어쓰지 않는다. 로컬 ACL·암호화 디스크·백업 권한은 운영자가 관리한다.

대상은 명시적으로 `staging`, `pilot`, `sharded`여야 하며 source 및 알려진 production의 Worker/origin·D1 ID/name·R2 bucket·Vectorize index·Analytics dataset을 재사용할 수 없다. logical shard ID/binding/mode는 유지하고 물리 리소스만 교체한다. `pilot` 자체는 네트워크 격리가 아니다. 별도의 접근 차단, provider 비활성화, quarantine Worker의 실접근 실패를 확인한다. 이 검사는 설정 파일을 대조하며 실제 Cloudflare binding ID·public bucket·대시보드 변경 여부는 독립 확인이 필요하다.

## 실측 증거와 승격 경계

처음 계획은 모든 check가 `pending`이고 `rpoSeconds`, `rtoSeconds`도 `null`이다. 실제 데이터 손실 구간과 복구 시작→검증 완료 시간을 측정해 초 단위로 기록한다. 목표 RPO/RTO와 허용 손실은 운영자가 먼저 정하며 도구가 보장값을 만들지 않는다.

필수 check ID는 `quarantine-isolation`, `credentials-invalidated`, `memberships-invalidated`, `identity-reconciled`, `tombstones-reconciled`, `current-heads-reconciled`, `schema-inventory-consistency`, `indexes-rebuilt`, `key-recovery-tested`, `authority-negative-tests`다. 마지막 항목에는 이전 session/PAT/proof/SCIM key, 회수 membership/share/domain, 삭제 payload로 접근이 실패하는 실제 시험을 포함한다.

각 check의 JSON 증거 파일은 다음 필드를 가진다. `format:1`, `check:<ID>`, `outcome:"passed"`, `manifestSha256`, `destinationFingerprint`, `observedAt:<capture 이후 epoch ms>`, `checks:[{name:<관찰 설명>,outcome:"passed"}]`. 비밀키·토큰·메일·본문은 넣지 않는다. 실제 관찰 없이 성공이라고 기입하지 않는다.

이를 묶는 drill evidence JSON은 `format:1`, 같은 `manifestSha256`, `destinationFingerprint`, `observedAt`, `measurements:{rpoSeconds:<실측>,rtoSeconds:<실측>}`, `checks:[{id,outcome:"passed",evidenceRef,evidenceFile,evidenceSha256}]`다. evidenceFile은 이 JSON 옆의 상대 경로이고 파일 SHA-256을 기록한다. 각 증거는 1 MiB 이하, 관찰 check는 1–1,000개이며 중복·누락·실패·미래 시각·다른 대상은 거부한다.

```powershell
node --experimental-strip-types scripts/recovery-cli.mjs drill-plan --config C:\private\source.jsonc --manifest C:\private\capture\manifest.json --sha256 CAPTURE때_별도보관한_64자리SHA256 --destination C:\private\quarantine.jsonc --quarantine --evidence C:\private\drill\evidence.json --out C:\private\drill-verified.json
```

`evidence-verified`도 `promotionAllowed:false`다. 이는 로컬 증거의 내용/해시/대상 검증이며 관찰 사실 자체의 제3자 인증이 아니다. 실제 기록을 [GA acceptance signer](GA_ACCEPTANCE.md)의 `multi-store-recovery` 형식에 연결하고 나머지 gate와 함께 운영자가 수락한다. 별도의 운영 변경 없이 live service를 전환할 수 없다.

## 키·외부 백업의 남은 한계

`PAYLOAD_KEY`는 AES-256-GCM으로 암호화한 임시 ingestion 원문을 복호화하는 데 필요하다. 복구 불가능한 키를 새 키로 교체하면 기존 ingestion 암호문을 복구하지 못한다. API export는 일반 JSON이며 이 키를 요구하지 않는다. R2 payload도 앱 계층에서 이 키로 암호화하지 않는 canonical JSON이다. 따라서 내려받은 object와 export 및 SQL 백업은 별도의 백업 암호화로 보호해야 한다. 키는 manifest에 넣지 않고 별도 암호화 escrow와 복구 시험으로 관리한다.

현재 staging 키 보관은 로컬 DPAPI `CurrentUser` 범위다. 이 사실만으로 다른 컴퓨터/계정에서의 복구 가능성을 입증하지 못하며, Proton 쓰기는 거부되어 외부 백업 완료 증거가 없다. 이 도구는 DPAPI 복호화·외부 provider 업로드·키 escrow를 구현하지 않는다. 독립 복구 가능한 암호화 키 보관, 실제 provider export/재수입·격리 drill, post-capture revoke/erasure 수집, 외부 암호화 백업·보존·만료 정책은 실제로 수행하고 검증할 작업으로 남는다.
