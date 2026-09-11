# 프레임워크 선택 — 2026-09-11

사용자는 백엔드에는 Hono를 필수로, 프런트엔드/풀스택에는 별도 제약이 없으면 TanStack Start + TanStack Router를 기본으로 지정했다. 이번 저장소 전환의 HTTP 진입점은 Hono로 바꾼다. 기존 인증·서명된 웹훅·MCP의 Request와 응답 계약을 보존하고, 요청별 저장소 선택·예외 처리·메트릭을 Hono에서 처리한다. 현재 콘솔의 기능을 유지하며 새 UI 구조는 TanStack 선택을 따른다. [Hono Workers 안내](https://hono.dev/docs/getting-started/cloudflare-workers).

자체 메모리 작업의 참고 자료로 공식 [cloudflare/agents](https://github.com/cloudflare/agents), [routing](https://github.com/cloudflare/agents/blob/main/docs/agents/routing.md), [scheduling](https://github.com/cloudflare/agents/blob/main/docs/agents/scheduling.md), [workflows](https://github.com/cloudflare/agents/blob/main/docs/agents/workflows.md)를 확인했다. 별도 agent lifecycle이 필요한 추출·압축·재임베딩 작업에서는 해당 SDK의 작업 실행과 상태 보존을 우선 검토한다. Agent 이름은 실제 검증된 tenant/Space와 세대로 정하고, 새 공개 agent route가 기존 권한 확인을 우회하지 않도록 한다.

[Flue의 Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)은 Agents SDK를 바탕으로 agent별 Durable Object와 실행 복구를 제공하며 Vite에서 Worker와 binding을 생성한다. 이 기능은 자체 agent harness가 필요한 단계의 후보로 유지한다. 현재 관리형 Agent Memory 호출이나 SQL 권한 저장소를 옮기는 데 harness가 필요한 것은 아니므로 이번 단계에서 Flue를 추가하지 않는다. 프레임워크가 작업을 재개하더라도 불확실한 provider 쓰기를 자동 재전송하지 않는 서비스 규칙은 유지한다.

서울 고정 데이터는 프레임워크의 기본 저장/로그/모델 경로까지 별도로 검증해야 한다. Cloudflare용 agent framework를 채택했다는 이유로 서울 전용 데이터가 Cloudflare에 들어가거나 서울 배치가 보장됐다고 표현하지 않는다.
