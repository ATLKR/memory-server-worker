# D1 실행 경로 전환

이번 구현은 기존 SQL 권한·이력·검색 동작을 SQLite Durable Objects로 옮길 수 있게 한다. 백엔드의 실제 HTTP 진입점은 Hono다. 테스트에서는 D1 바인딩 없이 실제 Worker를 실행하고, 서명된 스냅샷 복원 후 SSO·이메일 재인증·PAT·Space 권한·메모리 CRUD·검색·MCP·예약 작업을 검증한다. 로컬 workerd 검증과 실제 배포·데이터 이관의 성공은 별개의 증거다.

## 저장소 선택

`MEMORY_SQL_BACKEND=durable`이면 `MEMORY_SQL` 바인딩과 다음 설정을 모두 요구한다. 설정이 없거나 객체가 봉인되지 않았으면 요청을 거절한다. D1로 자동 복귀하지 않으며 DB/HOT 바인딩에 접근하지 않는다. HTTP와 예약 작업이 같은 선택기를 사용한다.

```json
{
  "MEMORY_SQL_BACKEND": "durable",
  "MEMORY_SQL_DEPLOYMENT_ID": "memory-staging",
  "MEMORY_SQL_EPOCH": "1",
  "MEMORY_SQL_DATABASES_JSON": "{\"DB\":{\"databaseId\":\"control\",\"kind\":\"control\"},\"HOT_01\":{\"databaseId\":\"hot-01\",\"kind\":\"hot\"},\"HOT_02\":{\"databaseId\":\"hot-02\",\"kind\":\"hot\"}}"
}
```

객체 이름은 `sql:<deploymentId>:<databaseId>:<epoch>`다. 운영과 스테이징은 배포 식별자를 공유할 수 없다. Durable 설정에는 D1 바인딩을 둘 수 없고, D1 migration 명령도 실행 전에 거절한다. 기존 D1 소스와 호환 검사는 유지한다.

현재 스테이징 설정은 새 SQL namespace와 임시 공개 서명 키만 추가하는 **PREPARE** 단계다. 이 설정에서는 D1이 계속 활성 상태다. 실제 이관 완료는 별도의 배포 영수증과 실환경 검증으로 확인해야 한다.

## 복원과 전환

서버 바인딩 전용 RPC가 SQL을 실행하며 공개 SQL endpoint는 없다. 각 batch는 하나의 동기 트랜잭션이다. 서명된 이관 RPC만 빈 대상 객체에 스냅샷을 넣을 수 있다. 공개 키가 없으면 새 이관을 허용하지 않는다.

스냅샷은 원본 스키마·행·순서·해시·대상 식별자를 고정한다. 임시 테이블에 청크를 넣은 뒤 하나의 트랜잭션에서 테이블 생성, 과거 행 복원, 외래 키 검사, 인덱스·트리거 복원을 수행한다. 과거 명령 행을 현재 트리거로 다시 실행하지 않는다. `rowid`, AUTOINCREMENT 최댓값, FTS 검색 행, 삭제 표식과 미완료 작업을 보존한다. 검증이 모두 끝난 객체만 ready가 된다. 봉인 후 이관으로 기존 DB를 덮어쓰거나 지울 수 없다.

현재 이관 도구의 한도는 행 100,000개, 행 청크 합계 16 MiB, 청크당 500행/512 KiB, 스키마 600개 객체다. 초대 단계에 맞춘 제한이며 큰 데이터의 이관 완료를 주장할 수 없다. 원문 행으로 인덱스를 재구성할 수 없는 external/contentless FTS 및 지원하지 않는 SQL 형태는 사전에 거절한다.

원본에는 점검 진입 게이트를 켠 뒤 control과 모든 hot DB에 정확한 쓰기 차단 트리거를 설치한다. 트리거 정의를 모두 검증하기 전에는 동결로 취급하지 않는다. 임시 차단 트리거는 이름과 SQL 해시가 일치하는 경우에만 복원 대상에서 제외하고, 기존 런타임 보안 트리거는 보존한다. 이관 도중 결과가 불명확하면 기록과 상태를 조회하며 일반 쓰기를 자동 재전송하지 않는다.

R2 백업은 이미 별도 보관한 배포 payload 키에서 HKDF로 분리한 키를 만들어 AES-GCM으로 암호화한다. 배포·DB·세대·실행 ID·계획 해시를 암호화에 결합한다. 임시 이관 서명 키가 없어도 기존 복구 키로 백업을 복호화할 수 있다. 평문 스냅샷·개인 키·자격 증명은 저장소나 운영 로그에 남기지 않는다.

기존 Worker의 외부 쓰기는 SQL 차단 이후에도 끝날 수 있다. 불변 R2 식별자, 영구 purge 표식, 버전별 벡터 ID, 기존 예약·lease·재시도·삭제 확인 상태를 모두 넘겨야 한다. 대기 시간이나 비어 있는 큐만으로 외부 호출 종료를 단정하지 않는다. 대상에서 새 쓰기를 받은 뒤 오래된 D1로 단순 롤백하지 않는다.

## 남아 있는 경계

기존 중앙 권한 DB는 배포당 하나의 control 객체에 남고 hot shard는 각 객체로 나눈다. 객체마다 [10 GB 제한](https://developers.cloudflare.com/durable-objects/platform/limits/)이 있으므로 무제한 확장 구조가 아니다. 향후 tenant 권한 분리가 필요하다. 새 Agent Memory 작업 상태는 이미 Space별 별도 객체를 사용한다.

서울 고정 데이터의 PostgreSQL/pgvector 경로는 별도 런타임과 인증·임베딩·지역 검증이 필요하다. 이번 비서울 SQL 객체 전환으로 서울 경로까지 출시된 것은 아니다. 새로운 UI와 자체 agent workflow는 [프레임워크 결정](framework-decisions.ko.md)을 따른다.
