# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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

[2.1.0]: https://github.com/ATLKR/memory-server-worker/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/ATLKR/memory-server-worker/releases/tag/v2.0.0
