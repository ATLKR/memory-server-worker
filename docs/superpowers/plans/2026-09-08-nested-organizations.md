# Nested organizations implementation plan

The user approved arbitrary nesting with **no permission inheritance**. This bounded extension adds immutable parent metadata to existing organization creation. It does not change memory ACLs or add reparent/delete/move operations.

- [x] Write SQLite regressions for deep nesting, independent parent/child authority, hidden unauthorized parent metadata, live creator authority, immutable/cycle guards, and rollback.
- [x] Add `hierarchy-schema.sql` and the fifth forward migration. A child command validates the live parent owner/admin and chosen own email, invokes the existing atomic organization creation command, and inserts an immutable edge. Preserve deployed migrations 0001–0004 byte-for-byte.
- [x] Extend WorkspaceService creation with optional `parentOrganizationId` and snapshot organization metadata with `parentId` only when that parent is explicitly accessible. Update migration checking and local/test schema loaders; root owns HTTP/UI wiring.
- [x] Run workspace/regression/type checks, verify old migration hashes, and validate the fifth schema on local workerd/D1. No commit or deployment in this task.

No fixed depth field or product depth limit is introduced. Ancestor metadata never grants authority. Existing organizations remain independent roots after the forward migration.

Validation: 32 workspace SQLite tests pass; complete `npm run check` passes 171 tests, TypeScript, and frozen baseline hashes. `npm run test:d1` passes a populated four-to-five migration upgrade on local workerd/D1, child creation, hidden parent metadata, exact organization memory/key authority, and parent-only offboarding with continuing child access. Remote migration/deployment remains outside this bounded task.
