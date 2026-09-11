# 초대 기반·사용량 계량 GA 판정표

현재 최종 GA 승인은 **대기**다. 선택한 범위는 초대 기반 가입, 관리형 메모리, AI 검색·검토형 추출과 사용량 계량이며 **유료 결제는 제외**한다. 이번 판정은 무제한 공개 가입이나 법규 준수 인증이 아니다.

후보는 0.5.0-rc.1/중앙 25/HOT 1이다. Production은 rc.3/중앙 1–7, staging은 이전 revision `1a93820`/중앙 1–23/HOT 1이다. 중앙 24–25와 최신 수정은 아직 배포하지 않았다. [통합 기록](INTEGRATION.md)의 과거 rc.4 결과를 현재 후보의 최종 통과로 읽지 않는다.

## 구현 및 기록된 검증

물리 HOT D1 샤딩·canonical 비공개 R2·중앙 권한/receipt/논리 quota·제한된 backfill/cleanup, REST/MCP, 공유/export/복원/제거, AI hybrid 검색·검토형 추출, 가입 roster 및 provider 비용 예약이 구현되어 있다. 한 Space를 실제 두 HOT에 분산한 이전 staging 검증이 있다.

같은 이전 staging에서 실제 SSO, scoped PAT, 공식 MCP SDK, AI 검색/추출, 10단계 조직의 독립 ACL, CRUD/복원/제거 및 계량을 확인했다. 메일 receiver 배포와 실제 proof 소비는 아직 대기다. 중앙 lifecycle 발행기/수신기는 native 두 Worker에서 9 events/11 deliveries와 재전송·재개를 검증했으나 중앙 발행기는 미배포다.

Authentication35는 해당 source에서 actionable finding 0건으로 종료했고 Storage36은 3건을 보고하여 수정이 배정되었다. 수정 후 해당 영역을 다시 검토한다. Console34의 self-removal UI와 오래된 배포 문서 finding을 수정한 뒤 console 재검토도 필요하다. 현재 전체 테스트 수와 전체 영역의 zero-finding 결론은 최종 재실행·review 종료 전 기록하지 않는다.

## 최종 revision의 필수 gate

[GA_ACCEPTANCE.md](GA_ACCEPTANCE.md)의 15개 gate는 코드의 필수 목록과 일치한다: source-validation, sso-session, mail-proof, workspace-authority, identity-revocation, pat-mcp-clients, ai-retrieval, reviewed-ingestion, sharing-export-erasure, metering-quotas, physical-storage, multi-store-recovery, load-capacity, observability-response, operational-policy.

각 gate는 실제 대상·revision·중앙/HOT schema·리소스 지문, 시각, 검사 결과 및 증거 파일 SHA-256을 가져야 한다. 명시적 일반 테이블/DDL 복구 exporter의 native 검증은 provider 복구 훈련을 대신하지 않는다. 실제 전체 D1 export의 FTS 거절을 반영해 격리된 다중 저장소 복구를 수행한다.

`LIVE_ACCEPTANCE_ID` 문자열만으로는 승인되지 않는다. `/ready`는 Ed25519 서명된 `LIVE_ACCEPTANCE_JWS`, 공개 키, 번들 source/config 지문, 중앙 25/HOT 1, 필수 binding, heartbeat, 초대 설정과 AI 예약 예산을 검사한다. 서명은 최대 7일이며 모든 15개 gate의 증거가 필요하다. 기술 설정 통과와 운영자 승인 완료를 구분한다.

## 운영 결정과 제외 범위

- Memory 전체 Cloudflare 월 $50 목표에 맞춰 production AI 예약 상한 $20과 staging $0.20, 별도 인프라 청구·경보·중단 대응을 검증한다. 예약 예산은 전체 청구액의 자동 상한이 아니다.
- 계정/이메일/법정 보존/복구 사본까지 포함한 전체 개인정보 삭제 workflow, 사고·지원 대응, RPO/RTO와 보존 정책은 운영 결정 및 이행 증거가 필요하다. 개별 기억 접근 제거 receipt는 R2/HOT/벡터 물리 제거 완료가 아니다.
- 기존 개인용 서비스의 자동 이관, 자동 의미 충돌 통합, 개인용 검색 엔진과 완전한 품질 동등성, 전체 SCIM/SAML, Zero-Access 및 규제 인증은 제공하지 않는다.
- 유료 결제, 가격·환불·정산 수락은 이번 GA에서 제외하고 비활성 상태를 유지한다. 이를 활성화하려면 별도의 변경·수락이 필요하다.

실제 메일 receipt, lifecycle 배포와 지연/누락 복구, 용량·비용·alert 대응 및 격리 복구를 완료하고 정확한 최종 source로 재검증한 뒤 승격한다.
