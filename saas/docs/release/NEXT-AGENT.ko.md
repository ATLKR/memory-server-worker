# 원본 환경에서 이어받는 에이전트 지시

이 ZIP은 PR #22 b94c434f2074ea975111cb4e3efd4371a9481ac1을 위한 실제 코드 확장이다. README의 범위와 LAUNCH-GATES를 먼저 읽는다. 기존 개인용 Worker를 대체하거나 원격 배포하지 않는다.

먼저 copy-only assembler로 새 로컬 사본을 만들고 기준 blob/원본 migration 보존을 확인한다. 원본 전체를 확보한 환경에서 verify-upstream.mjs, npm ci, npm run check, npm run test:d1을 실행한다. fixture 테스트 통과를 전체 원본 통합 통과로 바꾸어 보고하지 않는다. 실패 시 새로운 기능보다 원본 schema/type/runtime와의 차이를 우선 수정하고 회귀 테스트를 추가한다.

그다음 별도 staging에서 실제 SSO/메일/DNS/AI/Vectorize/결제 test mode/회수/복구를 검증한다. 운영 secret이나 사용자 원문은 로그·프롬프트·테스트 fixture에 넣지 않는다. 독립된 리뷰에서 tenant 경계, delegated key, stale JWT, 원문/백업 삭제, quota 동시성, lease 만료와 provider 재시도를 다시 점검한다.

GA 미완료 항목을 단순 TODO 주석으로 숨기지 않는다. 계정/이메일/결제 전체 개인정보 삭제 workflow, 필요 시 개인용 자동 이관과 SCIM 프로비저닝, 장기 원장 크기 관리, 복구/경보, 약관·보존 동의 기록을 실제 제품 범위에 맞게 구현하고 검증한다. 설정 플래그로 실제 검증을 대신하지 않는다.

완료 보고는 변경 파일, 실제 실행한 명령과 결과, 미실행 항목, 남은 위험을 구분한다. 사용자 승인이 있기 전에는 push/merge/production migration/결제를 하지 않는다.
