# 검증 범위

최종 판정은 `evidence/FINAL-TESTS.txt`와 `evidence/VALIDATION.json`을 확인한다. 파일 manifest는 `MANIFEST.json`, 검증기는 `tools/verify.mjs`다.

## 이 실행 환경에서 수행

- 추가 TypeScript 모듈 strict 정적 검사. 원본 파일을 import하는 `release/worker.ts` 진입점은 이 standalone 검사에서 제외한다.
- Node 내장 SQLite의 실제 statement/transaction/trigger/FTS5를 사용하는 테스트. provider 호출만 모의 응답으로 처리한다.
- 작업 키 충돌·revision·권한 회수와 교차 Space·append/update-only receipt·공동 quota·보존/영구 제거·export snapshot·공유·검색 결과 필터링·lease/retry/복구·메일/DNS/서명 이벤트·SCIM 회수·결제 이벤트 재조정·검토형 추출·만료·MCP/REST·평가 계산기 검증.
- 정확한 baseline `app.ts` Git blob SHA와 패치 위치 확인, 해당 실제 app 소스에 확장 hook을 적용하여 인증/Origin/CSP/쿠키-key 거부/메모리 경로 우회를 확인했다. 주변 원본 모듈은 이 테스트에서 stub으로 치환했다.
- assembler의 잘못된 baseline/출력 경로 거부 및 migration source/생성 파일 일치 검사. **전체 원본 저장소가 있는 정상 경로의 clone→적용 끝까지는 실행하지 못했다.**
- 관리 화면 JS 구문 및 DOM 생성의 위험한 렌더링 사용 여부에 대한 코드 테스트. 실제 브라우저 렌더링/E2E는 실행하지 않았다.

## 수행하지 못한 것

원본 모든 migration/테스트/종속 모듈을 이 환경에 내려받아 실행하는 작업, 원본 Worker 전체 빌드/typecheck, 실제 workerd/Cloudflare D1/Vectorize, 브라우저 중앙 SSO, 실제 메일/DNS 소유권, AI 실제 출력, Stripe 실계정·정산, 장기 부하·침투 시험, 운영 DB 복구는 실행하지 못했다. 별도 확인 없이 통과로 기록하면 안 된다.

`tests/fixtures/base.sql`은 관련 테이블/열/메모리 trigger를 재현한 **집중형 테스트 fixture**이지 원본 0001–0005 전체가 아니다. 실제 전체 schema의 제약과 trigger 상호작용은 `tools/verify-upstream.mjs` 및 원본 통합 테스트에서 반드시 검증해야 한다. 이 추가 도구도 이번 환경에서 실제 원본 대상으로 실행한 것은 아니다.

## 판정 방식

테스트 성공은 해당 fixture·입력·가정 아래의 결과다. “안전한 배포 완료”, “모든 출시 기능 완료”, “규정 준수”, “독립 audit 완료”로 바꾸어 표현하지 않는다. 합성 평가 자료를 추가했지만 실제 검색 품질 점수는 측정하지 않았다.
