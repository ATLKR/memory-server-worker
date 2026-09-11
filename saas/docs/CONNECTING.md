# MCP와 플러그인 연결

Memory SaaS의 메모리 저장소는 **Space**다. Git 저장소와 자동으로 연결되지 않으며, 프로젝트마다 사용할 Space ID를 정한다. 연결 주소는 `https://memory.allenlabs.org/mcp`, 서버의 고정 ID는 `allenlabs-memory`다. 이 문서는 현재 SaaS 후보 코드의 연결 계약이며, 템플릿 추가만으로 운영 배포나 클라이언트 SSO 검증이 완료되지는 않는다.

| 연결 방식 | 접근 범위 | 적합한 경우 |
|---|---|---|
| 서비스 PAT | 발급 시 선택한 Space와 동작, 현재 계정·멤버십, 만료 기간 | 특정 프로젝트 저장소만 사용하는 플러그인·자동화 |
| 중앙 SSO | 중앙 OAuth 동의 범위와 현재 계정·멤버십 | 브라우저로 로그인하는 대화형 MCP 클라이언트 |

## 특정 저장소만 허용하는 PAT

1. 웹 콘솔에서 중앙 SSO로 로그인하고 PAT 관리 화면을 연다. 발급에는 5분 이내 본인 확인이 필요하다.
2. 개인 또는 한 조직을 고르고 허용할 Space를 명시적으로 선택한다. **조직 PAT는 한 조직의 현재 멤버십에만 연결되며 개인 Space나 다른 조직의 Space를 섞을 수 없다.** 개인 읽기 전용 PAT는 본인의 개인 Space와 수락한 읽기 공유 Space를 함께 선택할 수 있으며, 공유 원본이 조직 Space여도 가능하다.
3. 필요한 동작만 선택하고 1–90일의 만료 기간을 정한다. 토큰은 한 번 표시되므로 비밀 관리 도구에 저장한다.
4. 클라이언트 실행 환경의 `MEMORY_SAAS_PAT`에 토큰을 주입한다. 설정 파일에는 변수 이름만 둔다. 실제 토큰을 명령행 인수나 저장소 파일에 넣지 않는다.

| 권한 | 동작 |
|---|---|
| `read` | Space 목록, 기억 목록·조회·검색 |
| `create` | 기억 추가, 대화 추출 제출 |
| `update` | 기억 수정·복원; 대체 저장에는 `create`도 필요 |
| `delete` | 논리 삭제 |
| `export` | REST 내보내기 |

조직 member는 읽기 전용 조직 PAT를 발급할 수 있고, 나머지 capability는 현재 owner/admin 멤버십도 필요하다. 조직 키는 발급 당시의 정확한 멤버십·이메일에 연결되며 회수·만료 시 차단된다. 개인 PAT는 조직 멤버십만으로 조직 권한을 얻지 않는다. 조직 공유 Space를 개인 PAT의 `spaceIds`에 넣을 때는 `organizationId`를 생략하고 `capabilities: ["read"]`를 지정한다. 매 요청에서 공유 수락·만료·회수, 수신 이메일과 공유자의 현재 권한을 다시 검사하며 공유만으로 쓰기·내보내기를 허용하지 않는다. PAT로 Space 생성, 조직/키 관리, 최근 본인 확인이 필요한 영구 제거를 할 수 없다.

발급 API는 브라우저 세션으로 `POST /v1/keys`를 호출한다. [개인 요청 예제](../client/pat-request.personal.json)와 [조직 요청 예제](../client/pat-request.organization.json)의 ID를 실제 값으로 교체한다. `spaceIds`는 1–50개이며, 생략하면 그 개인/조직 범위 전체를 허용하고 개인 PAT의 읽기 범위에는 수락한 공유도 포함된다. 특정 저장소용 PAT에서는 생략하지 않는다. 서버가 범위를 검증하므로 MCP 인수의 `spaceId`를 바꿔도 권한이 넓어지지 않는다.

## Codex

PAT는 [codex.pat.toml](../client/codex.pat.toml), SSO는 [codex.sso.toml](../client/codex.sso.toml)의 테이블을 사용자 Codex 설정에 병합한다. 같은 서버에 둘을 중복 설정하지 않는다. PAT 방식에서는 Codex 프로세스가 `MEMORY_SAAS_PAT` 환경변수를 받아야 한다. SSO 방식에서는 다음 명령을 실행한다.

```sh
codex mcp login allenlabs-memory --scopes openid,profile,email,memory:read,memory:write,memory:delete
```

`bearer_token_env_var`와 OAuth 로그인 명령은 [공식 Codex MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)를 따른다. 위 명령은 로그인에 사용할 권한을 명시한다. 설정의 `scopes`는 [Codex 설정 문서](https://learn.chatgpt.com/docs/config-file/config-reference)에 정의되어 있지만, 자동 로그인에서는 서버의 `scopes_supported`가 우선할 수 있으므로 배열만 줄여서 권한 제한을 보장하지 않는다. 기존 ChatGPT 등록 앱 ID를 이 SaaS 주소에 재사용하거나 앱 설치를 자동 수행하는 설정은 포함하지 않는다.

## Claude Code와 MCP 기반 플러그인

현재 Claude Code 연결에는 [claude.pat.json](../client/claude.pat.json)의 `mcpServers` 항목을 프로젝트 `.mcp.json`에 병합하고 `${MEMORY_SAAS_PAT}`를 실행 환경에서 제공한다. 플러그인이 자체 `.mcp.json`을 제공하는 경우에도 같은 HTTP 서버 항목을 사용할 수 있다. [공식 Claude Code MCP 문서](https://code.claude.com/docs/en/mcp)를 참고한다.

**Claude Code SSO는 현재 중앙 callback 등록 정책과 호환성 확인이 필요하다.** Claude Code의 현재 문서는 `http://localhost:PORT/callback`을 사용하며 v2.1.231에서 이 형식을 복원했다고 명시한다. 아래에 기록된 중앙 DCR 정책은 `localhost`를 허용하지 않는다. [공식 callback 계약](https://code.claude.com/docs/en/mcp#use-pre-configured-oauth-credentials). 따라서 [claude.sso.json](../client/claude.sso.json)은 호환되는 callback 등록과 실제 로그인 검증이 끝난 뒤 사용할 참조 템플릿이다. 템플릿을 추가하거나 callback 포트만 고정해도 이 호스트 불일치는 해결되지 않는다. 이번 PR은 중앙 인증 정책을 변경하지 않았으며, 합성 JWT 테스트는 실제 Claude 등록·로그인 성공을 증명하지 않는다. 호환성을 확인한 뒤에는 `/mcp`에서 `allenlabs-memory` 인증을 시작한다.

SSO 템플릿의 `oauth.scopes`는 읽기·추가·수정·삭제에 필요한 권한과 계정 이메일 연결에 필요한 identity 권한을 명시한다. 이를 생략하면 현재 Claude Code는 401 응답의 `scope="memory:read"`를 따라 읽기 전용으로 로그인할 수 있다. 이미 그렇게 로그인했다면 `/mcp`에서 해당 서버의 인증을 지우고 다시 로그인하여 변경된 권한에 동의한다. 권한 문자열은 공백으로 구분하며 [Claude Code의 scope 설정](https://code.claude.com/docs/en/mcp#restrict-oauth-scopes)을 따른다.

읽기 전용 연결은 Claude Code에서 `oauth.scopes`를 `"memory:read"`로 바꾼 뒤 다시 인증한다. 조직 이메일 연결까지 필요한 첫 로그인에는 `"openid profile email memory:read"`를 사용한다. Codex에서는 `codex mcp login allenlabs-memory --scopes memory:read`로 요청할 수 있다. 클라이언트의 자동 재인증과 관계없이 특정 Space·동작 제한을 강제하려면 `capabilities: ["read"]`와 명시적인 `spaceIds`를 가진 PAT를 사용한다. `email`은 인증된 이메일 연결에, `profile`은 표시 이름에 사용되며 조직 권한 자체를 부여하지 않는다.

서버 연결과 별개로 [Space 사용 지침](../client/AGENT-GUIDANCE.md)을 프로젝트 지침이나 플러그인 스킬에 넣고 실제 Space ID를 지정한다. [MCP 인수 예제](../client/mcp-examples.json)는 현재 도구 이름과 필수 인수를 사용한다. PAT의 서버 권한 제한과 에이전트의 Space 선택 지침은 각각 설정해야 한다.

## 기존 Better Auth 기반 중앙 SSO

OAuth를 지원하는 원격 MCP 클라이언트는 서비스의 401 응답에 포함된 보호 리소스 메타데이터를 따라 로그인한다. 별도 Memory 비밀번호나 Better Auth 세션 쿠키를 플러그인에 복사하지 않는다.

유효한 SSO 토큰으로 도구를 호출했지만 필요한 동작 scope가 없으면 서버는 HTTP 403과 `WWW-Authenticate`에 추가로 필요한 scope를 반환한다. 이를 지원하는 클라이언트는 다시 동의를 요청할 수 있다. PAT의 고정된 capability 제한이나 Space 접근 권한 거부는 이 재인증 요청으로 해제되지 않는다.

| 항목 | 값 |
|---|---|
| MCP URL | `https://memory.allenlabs.org/mcp` |
| 보호 리소스 메타데이터 | `https://memory.allenlabs.org/.well-known/oauth-protected-resource` |
| 리소스 / JWT audience | `https://memory.allenlabs.org` |
| OAuth issuer | `https://auth-api.allen.company` |
| 중앙 로그인 UI | `https://auth.allen.company` |

클라이언트는 중앙 서버가 제공하는 메타데이터와 등록 정책을 사용해 Authorization Code + PKCE로 토큰을 받는다. 실제 클라이언트의 callback과 등록이 중앙 서버에서 허용되어야 한다. `unauthorized_client`나 redirect 오류가 나면 클라이언트 등록을 확인하며, 웹 콘솔의 `SSO_CLIENT_ID`나 `/auth/callback`을 임의로 복사하지 않는다.

중앙 서버는 public 클라이언트의 동적 등록(DCR)을 제공한다. 콜백은 정확한 HTTPS URL 또는 `http://127.0.0.1:<port>/...`·`http://[::1]:<port>/...` 형식이어야 하며, loopback의 임시 포트 변경을 지원한다. `http://localhost/...`는 허용되지 않는다. 별도 MCP 클라이언트는 자신의 콜백으로 등록하며 서비스의 브라우저 클라이언트를 재사용하지 않는다. access token은 15분이며, 갱신에는 `offline_access` 동의와 `refresh_token` grant가 모두 필요하다. 클라이언트가 `offline_access`를 추가할 수 있으므로 실제 동의 화면에서 확인한다.

SaaS는 중앙 access JWT의 서명, 정확한 issuer/audience와 만료를 검증한다. ID token이나 브라우저 쿠키는 MCP 인증 수단이 아니다. OAuth에는 `memory:read`가 필요하며 `memory:write`는 추가·수정 권한을 뜻한다. 삭제·내보내기는 별도 허용이 필요하며, 실제 요청 범위는 제공자의 지원·동의 정책을 따른다. PAT의 동작 권한과 OAuth scope 문자열은 서로 다른 형식이다.

**SSO로 로그인하는 것만으로 특정 Space에 제한되지는 않는다.** 각 도구의 `spaceId`는 대상을 고르는 값이다. 특정 저장소만 접근 가능하도록 강제해야 하면 명시적인 `spaceIds`로 PAT를 발급한다. SSO나 PAT 모두 조직 계층에서 권한을 자동 상속하지 않으며, 계정/조직 관리를 할 수 있는 브라우저 세션으로 승격되지 않는다.

## 이전 개인 서비스 플러그인과의 경계

`plugins/allenlim-memory-server`의 CLI·stdio bridge·Claude 훅, `plugins/openclaw-memory`, `distributions/chatgpt`는 기존 `memory.allenlim.net` 개인 서비스용이다. 프로필 기반 범위, `memory_pat_...` 토큰, 다른 도구 인수와 자동 캡처를 사용한다. **URL만 SaaS 주소로 바꾸지 않는다.** SaaS PAT는 받은 값을 그대로 Bearer로 보내며 기존 토큰 접두사를 붙이거나 `x-memory-api-key`로 바꾸지 않는다.

새 연결은 위 HTTP MCP 템플릿과 Space 지침을 사용한다. 기존 marketplace/app 등록, stable service ID와 MCP 도구 이름은 수정하지 않는다. stdio만 지원하는 클라이언트는 별도 검증된 HTTP MCP 어댑터가 필요하며, 이 문서는 기존 bridge의 SaaS 호환성을 주장하지 않는다.

## 연결 확인

- `memory_spaces`로 허용된 Space만 나오는지 확인한다. 추가 전용 PAT는 읽을 수 없으므로 콘솔에서 제공된 Space ID를 사용한다.
- 쓰기는 `operationId`를 요청 전에 만들고 응답 유실 때만 같은 ID·입력으로 재시도한다. 수정·삭제에는 현재 `expectedRevision`이 필요하다.
- `401`은 토큰 만료·회수/로그인, `403`은 Space·동작·멤버십, `409`는 버전 또는 작업 ID 충돌을 확인한다. `429`에서는 재시도 안내를 따른다.
- 원격 MCP는 JSON 또는 SSE 형식의 응답을 보낼 수 있다. 클라이언트가 협상하는 프로토콜과 응답 형식을 지원해야 한다.

로컬 템플릿 검증: `python -m unittest discover -s client -p "test_*.py"`와 `node --experimental-strip-types --experimental-sqlite --test client/connecting.test.mjs`를 `saas/`에서 실행한다. 이 검증은 설정 형식과 실제 로컬 MCP 계약을 확인하며 운영 OAuth 로그인이나 클라이언트 설치를 수행하지 않는다.
