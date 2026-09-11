# PostgreSQL 저장 리전 및 외부 처리 정책

> **후속 지시로 기본 아키텍처가 변경됨:** 사용자는 원문 Agent Memory ingest를 승인했고, Cloudflare에서 가능한 기능·데이터는 Cloudflare에 두며 별도로 외부 격리가 필요한 데이터만 서울 PostgreSQL에 두기로 했다. 아래는 이전 PostgreSQL 전면 이식 시점의 정책 기록이다. 일반 메모리를 Neon에 자동 배치하거나 의료 ingest에 추가 법률/BAA 승인을 요구하는 현재 정책으로 쓰지 않는다. 최신 판단은 [Cloudflare 저장 구조 검토](./cloudflare-storage-research.ko.md)를 따른다. `src/postgres/residency-policy.ts`는 아직 운영에 연결하지 않은 이전 PostgreSQL 대안용 기반 모듈이며 전체 서비스의 현재 라우터가 아니다.

2026-09-11 사용자 확정: **일반 메모리는 Non-Seoul(Neon Singapore)에 모으고, 의료·엄격 프로필은 Seoul(Supabase Seoul)에 고정한다.** Cloudflare Agent Memory 처리는 사용자가 추후 Cloudflare와의 BAA 또는 필터링 방식으로 정한다. 이 문서는 저장 배치와 외부 처리 권한을 분리한다. BAA 체결이나 필터 검증이 이미 완료됐다고 간주하지 않는다.

사용자 요청으로 실제 ChatGPT Chat의 표시 모델 **6 Pro**에서 [서울 데이터 분류 설계 검토](https://chatgpt.com/c/6aa3a8e0-5760-83e9-a81d-333d6cca2699)를 받았다. 실제 자료·접속정보는 제공하지 않았다. 모델 내부 별칭 Astra는 화면에서 확인하지 않았다. 해당 답변의 초기 의료 프로필 전체 비활성화 권고는 **후속 사용자 지시로 저장 배치 정책에 대해서는 채택하지 않는다**. 의료 저장 위치는 서울로 준비하며, 실행 경로의 검증 여부는 별도로 관리한다.

## 배치 표

| 데이터·프로필 | 저장 배치 | 적용 범위 |
|---|---|---|
| 일반 메모리, 일반 개인정보를 포함한 개인 메모리 | 기본 SG / Neon Singapore | 명시한 일반 프로필의 원문·revision·검색 데이터·jobs·지역 계량 |
| 건강·복약·검사 메모리 | KR / Supabase Seoul | 제품 정책상 의료 영역. 일반 등급을 선택해 SG에 넣는 우회 거절 |
| 의료기관 진료 자료·EMR 출처 | KR / Supabase Seoul | 원문과 임상 출처 태그 유지. 법정 기록 보존 역할은 별도로 판단 |
| 엄격 프로필, 기타 제한 정보 | KR / Supabase Seoul | 내용이 일반적이어도 엄격 프로필의 배치를 SG로 내리지 않음 |
| 요약·추출·태그·임베딩·질의 | 원천의 승인된 리전 | 원천 제한과 임상 출처 유지. 생성·검색 실행 위치는 저장 위치와 별도 |
| 원문·첨부·이전 버전·삭제 원장 | 대상 데이터와 같은 리전 | 파일명·OCR·썸네일도 포함. 이전 리전 자동 복제/복구 금지 |
| 지역 신원 연결·조직/Space ACL·PAT hash·회수 이력 | 권한이 적용되는 리전 | 중앙 SSO의 일반 로그인 계정과 지역 권한 원장을 구분 |
| 계량·quota·audit·운영 로그 | 대상 데이터의 지역 | 외부에는 승인된 최소 집계만. 사용자/기관/환자별 통계는 익명으로 가정하지 않음 |
| 백업·WAL·복제본·키·재식별 원장 | 해당 프로필이 승인한 경계 | 공급자 실제 보관·운영자 접근 범위는 별도 증거로 확인 |

주 저장 DB의 위치, 모든 저장물의 위치, 전 구간 처리 위치는 다른 보장이다. `ap-northeast-2`는 공급자 서울 리전이며 모든 장비가 서울특별시 행정구역에 있다는 의미로 쓰지 않는다.

## 코드와 서비스 적용

`src/postgres/residency-policy.ts`는 저장 배치 선택, 명시적 분류, 고정 리전·placement epoch, 파생 태그 상속을 검증한다. 일반 데이터를 SG로 모으는 기본값은 **선언된 데이터 등급/프로필**에만 적용한다. 분류나 배치가 없는 요청을 IP·이메일·국적·TLD로 추정하지 않는다. 건강정보를 먼저 해외 AI에 보내 분류하지 않는다.

새 placement 선택과 기존 placement 검증은 분리한다. 정책 버전, 등급, 분류 상태, 민감도 태그, 저장 리전, 처리 경계, epoch를 기록한다. 한 등급의 우선순위를 택하더라도 `clinical-origin` 등 원천 제한 태그를 삭제하지 않는다. 서로 다른 리전·프로필·epoch의 원천을 섞는 기본 파생 작업은 거절한다. 이 함수가 반환하는 정책은 원천 ACL·허용 수신자·목적·보유기간 교집합을 대신하지 않는다.

이 모듈의 `assertRegionalStorageAdmission` 통과는 **HTTP 본문 수신, AI 실행, MCP 결과 제공 또는 국외 이전 승인**이 아니다. Storage adapter와 별도로 처리자 정책을 적용한다. 중앙 Better Auth의 발급자 주소는 그대로 유지한다. 서울 전용 계정·복구·운영 권한까지 요구하는 처리 프로필에는 중앙 SSO의 실제 경계도 포함해 판단한다.

Cloudflare 연동은 `disabled / reviewed-filter / approved-provider` 같은 별도 처리자 정책으로 연결할 예정이며, 실제 승인/계약·필터 버전·대상 데이터·목적·기한·출력/로그 경계를 기록해야 한다. BAA가 의료 데이터를 SG에 저장하도록 배치를 바꾸지는 않는다. 필터링은 출발 리전에서 외부 전송 전에 수행하고 원문·토큰·환자별 식별자가 로그나 오류에 남지 않도록 검증한다. 단순 해시·벡터·가명화 결과를 자동으로 익명 데이터로 간주하지 않는다. 이 외부 처리자 연결은 이번 기반 모듈에 아직 구현하지 않았다.

지역 DB 장애나 설정 오류에서 SG↔Seoul, D1, R2로 자동 fallback하지 않는다. 복제·공유·export·해외 MCP 수신자·복구 목적지는 별도 데이터 이동 작업으로 다룬다. 현재 SQL 기반은 live authority를 전부 이식한 상태가 아니며, 지역별 객체 권한과 원천 삭제/회수 재검증을 완료하기 전 운영에 연결하지 않는다. 기존 운영 D1과 새 PostgreSQL에 동시에 쓰지 않는다.

## 공식 근거와 적용 판단

일반 개인정보의 국외 이전에는 조회·처리위탁·보관이 포함되며, 법에 정한 근거와 고지 등 적용 요건을 확인해야 한다. DB 사업자와 계약했다는 사실만으로 정보주체와의 계약 이행 필요성이나 별도 동의가 충족되는 것은 아니다. 건강정보의 민감정보 처리 근거와 국외 이전 근거도 별도로 판단한다. [개인정보 보호법 제28조의8](https://law.go.kr/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1029331979), [제23조, 2026-09-11 시행본](https://law.go.kr/lsLawLinkInfo.do?chrClsCd=010202&lsJoLnkSeq=1000575255).

ChatGPT 검토는 의료기관 외부 EMR 관리·보존의 국내 위치 조건을 고시 제7조 및 별표1의4.3/별표2에 근거해 설명했다. 개인 건강 메모와 기관의 법정 진료기록 보존 업무는 동일하게 단정하지 않는다. 실제 기관 업무의 고시 적용·보존기간·국외 처리 허용은 용도와 계약에 맞춰 확인한다. [전자의무기록 시설·장비 기준](https://law.go.kr/LSW/admRulLsInfoP.do?admRulSeq=2100000232676).

Supabase DPA의 리전 조항은 지정 지역 저장과 주된 처리 및 예외를 다루며, 그 자체로 모든 해외 운영·로그 접근의 부재를 증명하지 않는다. 실제 프로젝트·플랜·백업·지원 설정이 필요하다. [Supabase DPA, 2026-08-01](https://supabase.com/legal/customer-resources/data-processing-addendum).

Cloudflare Regional Services의 Workers 적용 범위에도 전역 code/secrets, outbound subrequests, Cron/Queues 등의 별도 경계가 있다. DB를 서울로 바꾸는 것으로 해결됐다고 표시하지 않는다. [Workers 지역 제한 문서](https://developers.cloudflare.com/data-localization/how-to/workers/).

이 정책은 사용자 제품 결정을 실행 가능하게 만드는 기준이다. 실제 데이터 이동이나 의료 서비스 준법 인증을 대신하지 않는다. 지역 PostgreSQL 포트, 실제 역할·연결·동시성·복구·SSO/PAT/REST/MCP/AI 검증, 소스 고정 배포를 완료해야 운영 전환을 선언할 수 있다.
