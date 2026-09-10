# Memory 서비스 개발 인수인계 — 2026-09-10

이 문서는 다른 PC의 개발 에이전트가 작업을 이어가기 위한 체크포인트다.
사용자가 현재 작업 업로드를 요청하여 구현과 배포 진행을 중단했다.
**GA 완료나 최신 후보의 운영 배포를 뜻하지 않는다.**

## 먼저 읽을 곳

- 제품 코드: [공개 PR #22](https://github.com/ATLKR/memory-server-worker/pull/22), 브랜치 `feat/saas-standard-foundation`.
- 중앙 인증: [비공개 PR #6](https://github.com/allenlabs/cf-worker-apps-private/pull/6), 브랜치 `memory/identity-lifecycle-delivery`.
- 상세 상태·운영 도구·검증 자료: [비공개 인수인계 폴더](https://github.com/allenlabs/cf-worker-apps-private/tree/memory/handoff-2026-09-10/handoff/memory/2026-09-10)의 **CONTEXT.ko.md**.
- 공개 설계/운영 문서: [INTEGRATION.md](release/INTEGRATION.md), [REVIEW_LOOP.md](release/REVIEW_LOOP.md), [MULTI_STORE_RECOVERY.md](release/MULTI_STORE_RECOVERY.md), [OPERATIONS_GA.md](release/OPERATIONS_GA.md).

비공개 저장소 접근이 되는 GitHub 계정으로 인증해야 상세 폴더를 읽을 수 있다.
이 문서가 들어 있는 공개 커밋과 비공개 CONTEXT의 정확한 SHA를 기준으로 시작한다.

## 사용자 결정

- 서비스 주소 `https://memory.allenlabs.org`; 중앙 Better Auth는 `auth.allen.company` / `auth-api.allen.company`.
- PAT 또는 SSO로 REST·MCP·플러그인을 사용한다. PAT는 선택적으로 정확한 Space 및 capability를 제한한다.
- 조직은 깊이 제한 없이 중첩 가능하다. 부모·자식 관계로 권한을 상속하지 않는다.
- 제품 표시 이름은 추후 상표에 맞춰 변경 가능하며 기술 식별자·OAuth 계약은 안정적으로 유지한다.
- Cloudflare Email을 사용한다. Resend로 바꾸지 않는다.
- 물리 D1 샤딩과 R2 분리, AI 검색·검토형 추출, 사용량 계량을 포함한다. 첫 GA에서 유료 결제는 제외한다.
- **초대 기반 GA, Memory 전체 Cloudflare 비용 월 $50 이내.** AI 예약 한도만으로 전체 비용 상한을 입증하지 않는다.
- 독립된 fresh 리뷰를 반복하고 사소한 구체적 결함도 수정한다. 현재 미해결 항목을 숨기지 않는다.
- 이 제품 저장소는 **public**이다. 기존 표준 GitHub Actions CI를 사용한다.

## 저장·권한 구조

중앙 D1이 계정·현재 권한·revision pointer·receipt·논리 사용량의 기준이다.
원문/body/source/provenance는 비공개 R2에 있고, HOT D1에는 불변 본문과 FTS를 둔다.
같은 Space도 여러 물리 HOT D1에 배치된다. Vectorize는 파생 인덱스다.

중앙 durable intent → create-only R2/HOT 준비 → 현재 권한·revision·quota를 확인하는
원자적 중앙 발행 순서를 사용한다. 지연된 외부 응답 뒤에는 현재 권한을 다시 확인한다.
영구 삭제는 R2 zero-byte marker와 HOT tombstone으로 늦은 업로드를 차단한다.
최대 16개의 active/draining shard를 지원한다. 기존 자료의 자동 재배치와 중앙 D1의
무제한 용량을 약속하지 않는다. Inline backfill은 명시적으로 켜는 제한된 작업이다.

## 실제 배포 상태

| 대상 | 마지막 확인 상태 |
| --- | --- |
| 운영 Memory | `0.4.0-rc.3`, 중앙 migration 1–7, 기존 pilot 그대로 |
| Staging Memory | `141f65f191a67ac5d654d72a2a9e88d856f22e63`, 중앙 1–25, HOT 1 두 개 |
| 현재 공개 소스 | `0.5.0-rc.1`, 위 배포 이후의 동시 재시도·복구·운영 검증 수정 포함 |
| 중앙 인증 소스 | `063588fea5267fe06877f7e5bbbebf83acdd527c`, 비공개 PR에 push 완료 |
| 중앙 인증 실제 배포 | 새 lifecycle publisher 및 migration 0010은 아직 미적용 |

Staging은 5분 cron이다. 현재 소스의 운영/staging 설정은 다음 배포를 위해 1분으로
바뀌었지만 아직 배포하지 않았다. 호출당 처리량 제한은 유지한다.
운영에는 중앙 migration 8–25와 HOT schema 1, 새 binding·secret·초대 설정 적용이 필요하다.

## 검증된 것과 남은 것

- `141f65f`의 GitHub CI·CodeQL·전체 SaaS/native workflow는 통과했다.
- 업로드 직전 `npm run check`는 **1,860개 테스트**를 통과했다: foundation208 + tooling230 + release1416 + clients6. TypeScript와 migration 비교도 통과했다.
- 수정된 동시 create/update/restore의 실제 D1/R2 native suite는 8개 테스트를 통과했다.
- 중앙 인증 UTF-8 수정은 85개 테스트·typecheck·build 및 실제 두 Worker/D1 lifecycle 시험을 통과했다.
- Staging `141f65f`에서 합성 계정 기반 17개 기능 + 3개 물리 검증을 통과했다. REST/PAT/공식 MCP SDK, AI 검색·grounded 추출/승인 재시도, 권한 분리, export/share/trash/restore/erase, metering 포함이다.
- 11개 현재 원문이 두 HOT D1과 R2에 있고, 11개 현재 벡터 및 삭제된 벡터의 최종 부재를 직접 확인했다. 추가 AI 예약은 $0.0328이다.
- 48회 인증 읽기, 동시성 4의 제한된 시험은 오류 0, p95 967 ms였다. 최대 처리량·장기 안정성 검증은 아니다.
- 이전 `1a93820`에서 실제 Cloudflare Email 수신과 원래 SSO 브라우저의 proof 소비를 완료했다. 임시 수신기·주소 라우팅·버킷은 삭제했다. 영구 사서함은 생성하지 않았다.
- 새 historical-cut 복구 도구 통합 후 공개 manifest/ops 120개가 통과했다. Work native 3개는 동시 실행 timeout/socket 종료로 미해결이다. 실제 일관된 캡처와 격리 복구는 미실행이다.

**알려진 미해결 리뷰:** 준비된 중앙 인증 실환경 fixture의 독립 정적 리뷰에 6개 지적이
남아 있다. 만료 후 변경, 불확실한 생성 결과/정리, 독립 trigger 정리, 전체 deadline,
지연 이벤트 후 권한 검증, 응답 media type이다. 비공개 보고서의 정확한 재현 조건을
먼저 확인한다. Fixture는 한 번도 원격 활성화하지 않았다.

Storage44·Authentication45는 인수인계 때문에 결과 없이 중단했다. 통과로 계산하지 않는다.
Historical recovery 통합도 새 독립 리뷰가 필요하다. 운영 rollout helper는 설계만 했고
아직 구현 파일이 없다.

## 다음 작업 순서

1. 비공개 CONTEXT와 포함된 리뷰 보고서를 읽고 정확한 소스·배포 상태를 다시 확인한다.
2. Work native 3개를 순차 재실행한다. Fixture의 6개 지적을 재현·수정하고, Storage44 / Authentication45 / 통합 복구 리뷰를 fresh context에서 다시 수행한다.
3. 기존 키의 안전한 이전 문제를 해결한다. 현재 DPAPI 파일은 원래 Windows 사용자/PC에 묶여 있다. 다른 PC에서 같은 이름의 새 키를 만들어 기존 staging secret을 덮어쓰지 않는다.
4. 최신 backup·배포 영수증·소스 확인으로 중앙 인증 rollout 계획을 새로 만든다. 오래된 계획/activation은 실행 근거로 재사용하지 않는다. 검증 후 실제 publisher 전달·SSO를 시험한다.
5. 실제 일관된 historical capture, 새 D1/R2/Vectorize로의 격리 복구, 권한 격리·후속 삭제/회수 보존·복구 시간/데이터 손실 범위를 검증한다.
6. 수정된 최종 후보를 staging에 배포하고 해당 SHA에 맞는 실환경 검증을 수행한다. 운영 rollout helper를 구현·리뷰한 뒤 backup을 새로 확인하고 pilot 운영 배포를 진행한다.
7. 실제 연락처·경보 전달/대응·비용 관측·키 복구를 마무리하고 15개 gate의 서명된 acceptance record가 충족될 때 GA로 승격한다.

사용자는 필요한 개발·리뷰·배포·실환경 검증을 이미 요청했다. routine 작업 승인을 반복해서
요청할 필요는 없다. 누락된 자격 증명·실제 연락처·새 provider 접근 동의는 별도로 확보한다.
키, 쿠키, 데이터베이스 덤프는 이 공개 저장소에 올리지 않는다.
