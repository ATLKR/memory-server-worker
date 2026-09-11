import { DurableObject } from 'cloudflare:workers';
import { SqlDatabaseEngine } from './engine.ts';
import { SnapshotImporter } from './snapshot.ts';
import type { SnapshotPlan, SnapshotGrant } from './snapshot.ts';
import type { DurableSqlExecution } from './types.ts';
import { SqlRecoveryController } from './recovery.ts';
import type { RecoveryFreezeInput, RecoveryScope, RecoveryReleaseInput, RecoveryGrant, RecoveryManifestInput, RecoveryChunkInput } from './recovery-types.ts';
interface MemorySqlEnvironment { MEMORY_SQL_IMPORT_PUBLIC_KEY?: string; MEMORY_SQL_RECOVERY_PUBLIC_KEY?: string }

/** Application SQL is reachable only through a server binding. An unbound or
 * unsealed object stays unavailable until the snapshot importer activates it. */
export class MemorySqlDatabase extends DurableObject<MemorySqlEnvironment> {
  protected readonly engine: SqlDatabaseEngine;
  private readonly importer: SnapshotImporter;
  private readonly recovery: SqlRecoveryController;
  constructor(ctx: DurableObjectState, env: MemorySqlEnvironment) {
    super(ctx, env);
    this.engine = new SqlDatabaseEngine(ctx.storage, { objectName: ctx.id.name ?? '' });
    this.importer = new SnapshotImporter(ctx.storage, { objectName: ctx.id.name ?? '', publicKey: env.MEMORY_SQL_IMPORT_PUBLIC_KEY ?? '' });
    this.recovery = new SqlRecoveryController({ storage: ctx.storage, objectName: ctx.id.name ?? '', publicKey: env.MEMORY_SQL_RECOVERY_PUBLIC_KEY ?? '' });
    ctx.blockConcurrencyWhile(async () => { this.engine.initialize(); this.importer.initialize(); });
  }
  execute(input: DurableSqlExecution) { return this.engine.execute(input); }
  beginImport(input: SnapshotPlan, grant: SnapshotGrant) { return this.importer.begin(input, grant); }
  appendImport(input: Parameters<SnapshotImporter['append']>[0], grant: SnapshotGrant) { return this.importer.append(input, grant); }
  sealImport(input: Parameters<SnapshotImporter['seal']>[0], grant: SnapshotGrant) { return this.importer.seal(input, grant); }
  abandonImport(input: Parameters<SnapshotImporter['abandon']>[0], grant: SnapshotGrant) { return this.importer.abandon(input, grant); }
  freezeRecovery(input: RecoveryFreezeInput, grant: RecoveryGrant) { return this.recovery.freezeRecovery(input, grant); }
  recoveryStatus(input: RecoveryScope, grant: RecoveryGrant) { return this.recovery.recoveryStatus(input, grant); }
  prepareRecoveryExport(input: RecoveryScope, grant: RecoveryGrant) { return this.recovery.prepareRecoveryExport(input, grant); }
  readRecoveryManifest(input: RecoveryManifestInput, grant: RecoveryGrant) { return this.recovery.readRecoveryManifest(input, grant); }
  readRecoveryChunk(input: RecoveryChunkInput, grant: RecoveryGrant) { return this.recovery.readRecoveryChunk(input, grant); }
  releaseRecovery(input: RecoveryReleaseInput, grant: RecoveryGrant) { return this.recovery.releaseRecovery(input, grant); }
}
