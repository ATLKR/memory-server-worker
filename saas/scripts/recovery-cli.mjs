import { runRecoveryCommand, RecoveryError } from './recovery-manifest.mjs';

try {
  process.stdout.write(JSON.stringify(await runRecoveryCommand(process.argv.slice(2))) + '\n');
} catch (error) {
  process.stderr.write((error instanceof RecoveryError ? error.message : 'Recovery validation failed. No provider action or promotion occurred.') + '\n');
  process.exitCode = 1;
}
