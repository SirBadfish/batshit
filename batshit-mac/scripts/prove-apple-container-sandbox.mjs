import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const repoRoot = resolve(macRoot, '..');
const workspaceRoot = join(repoRoot, '_local/evidence/mac-app/apple-container-sandbox-workspace');

const bashImage = process.env.BATSHIT_APPLE_CONTAINER_SANDBOX_BASH_IMAGE || 'bash:5.2';
const nodeImage = process.env.BATSHIT_APPLE_CONTAINER_SANDBOX_NODE_IMAGE || 'node:24-alpine';
const sessionName = 'batshit-sandbox-proof-session';
const networkName = 'batshit-sandbox-proof-internal';

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

async function runRequired(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const message = [result.stderr.trim(), result.stdout.trim()]
      .filter(Boolean)
      .join('\n');
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.code}: ${message}`);
  }
  return result;
}

async function bestEffort(command, args) {
  await run(command, args).catch(() => null);
}

async function cleanup() {
  await bestEffort('container', ['stop', '--time', '1', sessionName]);
  await bestEffort('container', ['delete', sessionName]);
  await bestEffort('container', ['delete', '--force', 'batshit-sandbox-proof-basic']);
  await bestEffort('container', ['delete', '--force', 'batshit-sandbox-proof-default-net']);
  await bestEffort('container', ['delete', '--force', 'batshit-sandbox-proof-internal-net']);
  await bestEffort('container', ['delete', '--force', 'batshit-sandbox-proof-memory-info']);
  await bestEffort('container', ['delete', '--force', 'batshit-sandbox-proof-memory-touch']);
  await bestEffort('container', ['network', 'delete', networkName]);
}

function assertIncludes(output, expected, label) {
  if (!output.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}.\nOutput:\n${output}`);
  }
}

async function assertContainerSystemRunning() {
  const status = await run('container', ['system', 'status']);
  if (status.code !== 0 || !status.stdout.includes('status') || !status.stdout.includes('running')) {
    throw new Error(
      'Apple Container system is not running. Run `container system start` before this proof.'
    );
  }
}

async function proofDisposableWorkspace() {
  const result = await runRequired('container', [
    'run',
    '--rm',
    '--name',
    'batshit-sandbox-proof-basic',
    '--cpus',
    '1',
    '--memory',
    '256M',
    '--read-only',
    '--volume',
    `${workspaceRoot}:/workspace`,
    '--workdir',
    '/workspace',
    bashImage,
    'bash',
    '-lc',
    'printf "APPLE_CONTAINER_SANDBOX_OK\\n" > proof.txt; pwd; cat proof.txt; if touch /root/should-not-write 2>root-write.err; then echo ROOT_WRITABLE; else echo ROOT_READ_ONLY; cat root-write.err; fi'
  ]);
  assertIncludes(result.stdout, '/workspace', 'Disposable workspace proof');
  assertIncludes(result.stdout, 'APPLE_CONTAINER_SANDBOX_OK', 'Disposable workspace proof');
  assertIncludes(result.stdout, 'ROOT_READ_ONLY', 'Read-only root proof');

  const marker = await readFile(join(workspaceRoot, 'proof.txt'), 'utf8');
  assertIncludes(marker, 'APPLE_CONTAINER_SANDBOX_OK', 'Host bind mount marker');
}

async function proofSessionReuse() {
  await runRequired('container', [
    'run',
    '--detach',
    '--name',
    sessionName,
    '--cpus',
    '1',
    '--memory',
    '256M',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--volume',
    `${workspaceRoot}:/workspace`,
    '--workdir',
    '/workspace',
    bashImage,
    'bash',
    '-lc',
    'trap "exit 0" TERM INT; while true; do sleep 1; done'
  ]);

  const first = await runRequired('container', [
    'exec',
    '--workdir',
    '/workspace',
    '--env',
    'BATSHIT_SANDBOX_PROOF=one',
    sessionName,
    'bash',
    '-lc',
    'printf "%s\\n" "$BATSHIT_SANDBOX_PROOF" > session-one.txt; pwd; cat session-one.txt'
  ]);
  assertIncludes(first.stdout, '/workspace', 'Session exec workdir proof');
  assertIncludes(first.stdout, 'one', 'Session exec env proof');

  const second = await runRequired('container', [
    'exec',
    '--workdir',
    '/workspace',
    sessionName,
    'bash',
    '-lc',
    'printf "two sees: "; cat session-one.txt; printf "two\\n" > session-two.txt; ls session-*.txt'
  ]);
  assertIncludes(second.stdout, 'two sees: one', 'Session reuse proof');
  assertIncludes(second.stdout, 'session-two.txt', 'Session second exec proof');
}

async function proofNetworkPolicyShape() {
  const defaultNet = await runRequired('container', [
    'run',
    '--rm',
    '--name',
    'batshit-sandbox-proof-default-net',
    '--cpus',
    '1',
    '--memory',
    '256M',
    '--read-only',
    '--tmpfs',
    '/tmp',
    bashImage,
    'bash',
    '-lc',
    'if timeout 3 bash -lc "echo > /dev/tcp/1.1.1.1/80" >/dev/null 2>&1; then echo DEFAULT_NET_OPEN; else echo DEFAULT_NET_BLOCKED; fi'
  ]);
  if (defaultNet.stdout.includes('DEFAULT_NET_BLOCKED')) {
    console.warn('Default network did not reach 1.1.1.1 during this run; internal-network denial will still be checked.');
  }

  await runRequired('container', ['network', 'create', '--internal', networkName]);
  const internalNet = await runRequired('container', [
    'run',
    '--rm',
    '--name',
    'batshit-sandbox-proof-internal-net',
    '--network',
    networkName,
    '--cpus',
    '1',
    '--memory',
    '256M',
    '--read-only',
    '--tmpfs',
    '/tmp',
    bashImage,
    'bash',
    '-lc',
    'if timeout 3 bash -lc "echo > /dev/tcp/1.1.1.1/80" >/dev/null 2>&1; then echo INTERNAL_NET_OPEN; else echo INTERNAL_NET_BLOCKED; fi'
  ]);
  assertIncludes(internalNet.stdout, 'INTERNAL_NET_BLOCKED', 'Internal network denial proof');
}

async function proofMemoryLimits() {
  const info = await runRequired('container', [
    'run',
    '--rm',
    '--name',
    'batshit-sandbox-proof-memory-info',
    '--cpus',
    '1',
    '--memory',
    '200M',
    '--read-only',
    '--tmpfs',
    '/tmp',
    bashImage,
    'bash',
    '-lc',
    'cat /sys/fs/cgroup/memory.max'
  ]);
  assertIncludes(info.stdout, '209715200', 'Memory cgroup proof');

  const touch = await run('container', [
    'run',
    '--rm',
    '--name',
    'batshit-sandbox-proof-memory-touch',
    '--cpus',
    '1',
    '--memory',
    '200M',
    '--read-only',
    '--tmpfs',
    '/tmp',
    nodeImage,
    'node',
    '-e',
    'const b = Buffer.allocUnsafe(512 * 1024 * 1024); for (let i = 0; i < b.length; i += 4096) b[i] = 1; console.log("MEMORY_LIMIT_NOT_ENFORCED", b.length);'
  ]);
  const combined = `${touch.stdout}\n${touch.stderr}`;
  if (touch.code === 0 || combined.includes('MEMORY_LIMIT_NOT_ENFORCED')) {
    throw new Error(`Memory limit did not block the proof allocation.\n${combined}`);
  }
  assertIncludes(combined, 'ERR_MEMORY_ALLOCATION_FAILED', 'Memory allocation failure proof');
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Apple Container sandbox proof only runs on macOS.');
  }

  await mkdir(workspaceRoot, { recursive: true });
  await rm(join(workspaceRoot, 'proof.txt'), { force: true });
  await rm(join(workspaceRoot, 'root-write.err'), { force: true });
  await rm(join(workspaceRoot, 'session-one.txt'), { force: true });
  await rm(join(workspaceRoot, 'session-two.txt'), { force: true });

  await cleanup();
  await assertContainerSystemRunning();
  await runRequired('container', ['image', 'pull', bashImage], { inherit: true });
  await runRequired('container', ['image', 'pull', nodeImage], { inherit: true });

  try {
    await proofDisposableWorkspace();
    await proofSessionReuse();
    await proofNetworkPolicyShape();
    await proofMemoryLimits();
  } finally {
    await cleanup();
  }

  const list = await runRequired('container', ['list', '--all']);
  if (list.stdout.trim() && !list.stdout.includes('ID  IMAGE')) {
    throw new Error(`Apple Container proof left containers behind:\n${list.stdout}`);
  }

  console.log('Apple Container sandbox proof passed.');
}

main().catch(async (error) => {
  await cleanup();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
