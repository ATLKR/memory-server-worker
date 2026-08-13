# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [3.1.1] - 2026-08-13

### Fixed

- Documented absolute Proton Pass CLI, Node, and bridge paths for the
  browser-free Devin integration, preventing working-directory command
  shadowing after credential injection.

## [3.1.0] - 2026-08-13

### Added

- Browser-approval-free CLI authentication through API keys or personal
  access tokens. `mem auth set --api-key-stdin` and `--pat-stdin` avoid argv
  exposure and write an origin-bound, owner-only local credential record.
- `MEMORY_PAT` support and a generic authenticated stdio-to-HTTP MCP proxy for
  clients that cannot attach custom HTTP authentication headers.
- Digest-only registry v3 distinguishes API keys from `memory_pat_...` PATs;
  credentials cannot be replayed through the other credential scheme.

### Security

- Conflicting `MEMORY_API_KEY` and `MEMORY_PAT` variables fail closed. Neither
  credential mode sends `x-memory-scope`, cross-origin redirects stay blocked,
  and CLI status/output never prints credential plaintext.

## [3.0.1] - 2026-08-13

### Fixed

- `mem --help` now prints usage to standard output and exits successfully;
  missing and invalid commands remain usage errors.

## [3.0.0] - 2026-08-13

### Breaking changes

- OAuth access tokens are now short-lived RS256 tokens issued by
  `https://auth-api.allen.company` and bound to the canonical
  `https://memory.allenlim.net` resource. Generic-audience tokens are accepted
  only during the bounded rollout window; clients must request the explicit
  OAuth resource after that window closes.
- Newly provisioned API-key registries must use version 2 with explicit
  `read`, `write`, and/or `delete` permissions and an RFC 3339 `expiresAt`.
  Version 1 remains temporarily readable only to permit a no-downtime
  production migration.
- CLI deletion now requires an interactive confirmation, or an exact `--yes`
  flag for intentional automation. Non-loopback HTTP server/auth overrides are
  rejected.

### Added

- Fifteen-minute access tokens with one-time rotating refresh tokens and a
  30-day absolute session lifetime for the browser UI and `mem` CLI.
- Proactive browser refresh, focus/visibility recovery, refresh-on-401 with one
  retry, cross-tab refresh-race handling, and upstream refresh revocation on
  logout.
- Public OAuth dynamic client registration with PKCE S256 and an ephemeral
  loopback callback for terminal login; credentials are stored atomically with
  owner-only permissions.
- API-key registry v2 least-privilege permissions, mandatory expiry, and
  optional scheduled disablement across REST and MCP operations.
- Real workerd integration coverage, release build provenance, deploy version
  metadata, source maps, and a UI favicon.

### Changed

- Codex, Claude Code, Devin, the `mem` CLI, and ChatGPT distribution metadata
  are synchronized at `allenlim-memory-server` 3.0.0 in the
  `allenlim-plugins` marketplace.
- Devin installs reusable skills only and connects the remote MCP separately,
  requesting the Memory resource and its read/write/delete OAuth scopes.
- Successful and error payloads, MCP/SSE output, OAuth responses, transcript
  input, and upstream JSON are size-bounded; client URLs require HTTPS except
  for explicit loopback development.

### Security

- OAuth issuer, audience, authorized-party, token-use, expiry, and scope claims
  are validated before Memory profile access.
- Logout revokes the refresh family while still clearing local credentials;
  token rotation is race-safe across browser tabs and CLI processes.
- API-key plaintext stays outside source and Worker configuration; only
  digest-backed registry entries are accepted.

## [2.1.0] - 2026-08-12

### Added

- Digest-only, server-mapped API-key authentication for automation.
- Incremental transcript capture with retry-safe local checkpoints.
- Browser sessions backed by secure, HttpOnly cookies.
- Reproducible ChatGPT plugin artifacts, checksums, SBOM release assets, CodeQL,
  and Dependabot automation.

### Changed

- Plugin clients now fail correctly on MCP `isError` responses and enforce
  bounded request timeouts.
- Worker errors, logging, browser security headers, and UI recovery behavior
  are hardened.

### Security

- API keys are stored only in Proton Pass while Cloudflare receives SHA-256
  digests in a Worker secret.
- Browser JavaScript no longer reads or persists the SSO bearer token.

## [2.0.0] - 2026-08-12

### Changed

- Migrated the Worker to Agents SDK 0.20 and MCP Server SDK 2.0.
- Renamed the marketplace to `allenlim-plugins` and the plugin to
  `allenlim-memory-server`.
- Bound memory profiles to authenticated user identities and migrated the
  known production profile without deleting the legacy source.

[3.1.1]: https://github.com/ATLKR/memory-server-worker/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/ATLKR/memory-server-worker/compare/v3.0.1...v3.1.0
[3.0.1]: https://github.com/ATLKR/memory-server-worker/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/ATLKR/memory-server-worker/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/ATLKR/memory-server-worker/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/ATLKR/memory-server-worker/releases/tag/v2.0.0
