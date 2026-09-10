import { deploymentErrorMessage, loadDeploymentConfiguration, parseDeploymentArguments } from './deployment-config.mjs';

try {
  const target = await loadDeploymentConfiguration(parseDeploymentArguments(process.argv.slice(2)));
  process.stdout.write(`Local ${target.environment} deployment configuration passes. Remote SSO allowlist, resources, migrations and domain ownership still require verification.\n`);
} catch (error) {
  process.stderr.write(deploymentErrorMessage(error) + '\n');
  process.exitCode = 1;
}
