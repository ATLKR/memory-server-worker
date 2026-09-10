import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeploymentConfigurationError, deploymentErrorMessage, deploymentFingerprint, loadDeploymentConfiguration, parseDeploymentArguments, PROJECT_DIRECTORY } from './deployment-config.mjs';

const require = createRequire(import.meta.url);
const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');

function captureGit(args) {
  return new Promise((accept, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', ['--no-optional-locks', ...args], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; });
    child.once('error', () => reject(new DeploymentConfigurationError('Cannot inspect the deployment Git source.')));
    child.once('close', code => code === 0 ? accept(output) : reject(new DeploymentConfigurationError('Cannot inspect the deployment Git source.')));
  });
}

export async function inspectGitSource() {
  const repository = (await captureGit(['-C', PROJECT_DIRECTORY, 'rev-parse', '--show-toplevel'])).trim();
  const revision = (await captureGit(['-C', repository, 'rev-parse', 'HEAD'])).trim();
  const status = await captureGit(['-C', repository, 'status', '--porcelain=v1', '--untracked-files=all', '--', '.',
    ':(exclude,glob)**/.local/**', ':(exclude,glob)**/node_modules/**']);
  if (!/^[a-f\d]{40}$/.test(revision)) throw new DeploymentConfigurationError('Cannot identify the deployment source revision.');
  return { revision, dirty: status.length > 0 };
}

export function runProcess(command, args, options = {}) {
  return new Promise((accept, reject) => {
    // Invoke JS entry points with the current Node executable, including on Windows.
    // No cmd.exe, shell quoting, npx resolution or unknown argument forwarding.
    const child = spawn(command, args, { stdio: 'inherit', ...options, shell: false });
    child.once('error', () => reject(new DeploymentConfigurationError('Could not start the deployment command.')));
    child.once('close', code => {
      if (code === 0) accept();
      else reject(new DeploymentConfigurationError(code === null ? 'Deployment command was interrupted.' : `Deployment command failed (exit code ${code}).`));
    });
  });
}

export async function runDeploymentCommand(argv, { runner = runProcess, cwd = process.cwd(), productionConfigPath, npmCliPath = process.env.npm_execpath, processEnvironment = process.env, inspectSource = inspectGitSource } = {}) {
  const [operation, ...args] = argv;
  if (!['build', 'db:local', 'db:remote', 'deploy'].includes(operation))
    throw new DeploymentConfigurationError('Choose build, db:local, db:remote or deploy.');
  const selection = { ...parseDeploymentArguments(args), cwd, productionConfigPath, processEnvironment };
  const target = await loadDeploymentConfiguration(selection);
  const options = { cwd: PROJECT_DIRECTORY, shell: false };
  const source = operation === 'build' || operation === 'deploy' ? await inspectSource() : null;
  if (source && (!/^[a-f\d]{40}$/.test(source.revision) || typeof source.dirty !== 'boolean'))
    throw new DeploymentConfigurationError('Cannot identify the deployment source revision.');
  if (operation === 'deploy') {
    if (source.dirty) throw new DeploymentConfigurationError('Deployment requires clean tracked and untracked repository source. Commit or remove uncommitted source changes first.');
    if (!npmCliPath) throw new DeploymentConfigurationError('Run deployment through npm run deploy so repository checks can run first.');
    await runner(process.execPath, [npmCliPath, 'run', 'check'], options);
    const checked = await loadDeploymentConfiguration(selection);
    if (checked.path !== target.path || JSON.stringify(checked.config) !== JSON.stringify(target.config))
      throw new DeploymentConfigurationError('Deployment configuration changed during repository checks. Review the target and run again.');
    const checkedSource = await inspectSource();
    if (checkedSource.dirty || checkedSource.revision !== source.revision)
      throw new DeploymentConfigurationError('Deployment source changed during repository checks. Review the clean source and run again.');
  }
  const argumentsByOperation = {
    build: ['deploy', '--dry-run', '--outdir', join(PROJECT_DIRECTORY, '.local/build')],
    'db:local': ['d1', 'migrations', 'apply', 'DB', '--local'],
    'db:remote': ['d1', 'migrations', 'apply', 'DB', '--remote'],
    deploy: ['deploy'],
  };
  const definitions = source ? ['--define', `BUILD_SOURCE_REVISION:${JSON.stringify(source.dirty ? 'unreleased' : source.revision)}`,
    '--define', `BUILD_RESOURCE_FINGERPRINT:${JSON.stringify(deploymentFingerprint(target.config))}`] : [];
  const commands = operation === 'db:local' || operation === 'db:remote'
    ? [...target.hotBindings, 'DB'].map(binding => ['d1', 'migrations', 'apply', binding, operation === 'db:local' ? '--local' : '--remote'])
    : [argumentsByOperation[operation]];
  for (const command of commands) {
    const checked = await loadDeploymentConfiguration(selection);
    if (checked.path !== target.path || JSON.stringify(checked.config) !== JSON.stringify(target.config))
      throw new DeploymentConfigurationError('Deployment configuration changed before the next command. Review the target and run again.');
    await runner(process.execPath, [wrangler, ...command, ...definitions, '--config', target.path], options);
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runDeploymentCommand(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(deploymentErrorMessage(error) + '\n');
    process.exitCode = 1;
  }
}
