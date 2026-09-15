# 검색 품질 비교

`eval/corpus.jsonl`과 `eval/cases.jsonl`은 개인정보가 없는 합성 평가 자료다. 10가지 사실의 한국어/영어 변형 50문항과 접근 금지 Space의 부정 사례 1문항으로 구성했다. 이전 담당자 사실, 삭제된 기억, 다른 Space의 자료를 방해 항목으로 포함한다.

이것은 **평가용 입력과 계산기**이며 실제 Vectorize/Agent Memory 응답을 수집하거나 좋은 점수를 달성했다는 의미가 아니다. 실제 업무 품질을 대표하는 검증된 benchmark도 아니다.

두 엔진에 같은 corpus와 동일한 접근 권한/삭제/supersession 상태를 넣는다. corpus의 `id`는 평가용 ID이다. 새 SaaS는 서버가 ID를 발급하므로 삽입 시 반환한 ID와 평가 ID의 mapping을 저장하고 응답을 평가 ID로 변환해야 한다. corpus의 `supersededBy`/`deleted`는 준비 절차를 설명하는 값이지 그대로 POST할 API 인수가 아니다. 이 자동 loader는 포함하지 않았다.

각 엔진의 실제 결과를 다음 JSONL로 저장한다.

```json
{"caseId":"retry-1","results":["eval-retry"],"latencyMs":123}
```

```sh
node tools/evaluate.mjs eval/cases.jsonl /path/to/actual-responses.jsonl
```

계산기는 recall@5, MRR@5, 알려진 금지/과거 결과 수, 부정 사례의 잘못된 검색, 관측된 latency의 p95, 평가 누락 여부를 보고한다. privacy 결과 검사는 상위 5개에만 제한하지 않고 반환된 전체 ID를 검사한다. API 실패와 누락을 임의의 정답으로 바꾸지 않는다. 비용은 provider 청구/usage 자료를 별도로 집계한다.

출시 전에는 실제 사용자의 허가를 받아 익명화한 질문 세트, 시간 변화, 모순 정정, 삭제, 퇴사자 회수 및 장문 데이터를 추가해야 한다. 합성 사례의 단어 일치 성능만으로 의미 검색 품질을 판단하지 않는다.
