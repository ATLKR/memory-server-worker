# Deprecated surfaces — do not extend

PostgreSQL (`postgres/migrations/`, `src/postgres/`, `src/release/`) is the
durable-authority lineage. The surfaces below remain only until the production
D1→PostgreSQL cutover completes and retire after it. Add nothing new to them.

- `d1-migrations/`, `d1-shard-migrations/` — D1/SQLite schema lineage.
  Frozen: no new migrations. Still the live production schema until cutover,
  so files stay deployable and byte-immutable.
- `src/deprecated-durable-sql/` — Durable-Objects SQLite backend
  (`MEMORY_SQL_BACKEND=durable`). Never deployed (no `durable_objects`
  binding in any wrangler config); superseded by the PostgreSQL regional
  path. Kept because `release/worker.ts` still resolves the backend enum
  and the Seoul-projection capture adapters name `durable-sql` as a source
  kind. Remove with the backend enum at cutover.
- `test/deprecated/` — integration suites covering the D1/DO backends.
  `npm run test:d1` and `test:durable-sql` target these paths. The product
  services under `src/` already speak PostgreSQL-native SQL
  (`memory_identity.*`, `jsonb_agg`, `?::jsonb`), so `test:d1` fixtures that
  apply the flat D1 schema are stale and fail at runtime — they are kept for
  schema-history reference, not as a green gate. `test:durable-sql` remains
  green (198 tests).
- `release-validation/retired-d1/` — earlier retirement convention; tests of
  D1-lineage projection machinery.

`src/memory.ts`, `src/workspace.ts`, `src/api.ts`, `src/app.ts`,
`src/mcp.ts`, `src/auth.ts`, `src/ui.ts`, `src/identity.ts` are shared
product modules still serving the live worker; they are not per-backend and
stay until the cutover retires the D1 API surface.
