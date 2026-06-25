import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  access,
  appendFile,
  readdir,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const packagedRuntimeRoot = resolve(__dirname, '..', 'runtime');
const packagedAppRoot = join(packagedRuntimeRoot, 'batshit-app');
const packagedServerRoot = join(packagedRuntimeRoot, 'batshit-server', 'server');
const packagedLiveKitSidecarSourceRoot = join(packagedRuntimeRoot, 'tools', 'livekit-agent-sidecar');
const packagedRedisStackRoot = join(packagedRuntimeRoot, 'vendor', 'redis-stack');
const packagedFfmpegRoot = join(packagedRuntimeRoot, 'vendor', 'ffmpeg');
const fallbackRepoRoot = resolve(macRoot, '..');
const usePackagedRuntime =
  !process.env.BATSHIT_MAC_REPO_ROOT &&
  existsSync(packagedAppRoot) &&
  existsSync(packagedServerRoot);
const repoRoot = process.env.BATSHIT_MAC_REPO_ROOT
  ? resolve(process.env.BATSHIT_MAC_REPO_ROOT)
  : usePackagedRuntime
    ? packagedRuntimeRoot
    : fallbackRepoRoot;
const appRoot = usePackagedRuntime ? packagedAppRoot : join(repoRoot, 'batshit-app');
const serverRoot = usePackagedRuntime ? packagedServerRoot : join(repoRoot, 'batshit-server', 'server');
const appProductionBuild = join(appRoot, 'build');
const useProductionApp = existsSync(appProductionBuild);

const DEFAULT_PORTS = {
  app: Number(process.env.BATSHIT_FRONTEND_PORT || 5620),
  server: Number(process.env.BATSHIT_SERVER_PORT || 5600),
  mcp: Number(process.env.BATSHIT_MCP_STREAMABLE_PORT || 5601),
  dockerMcp: Number(process.env.BATSHIT_MAC_DOCKER_MCP_GATEWAY_PORT || process.env.DOCKER_MCP_GATEWAY_PORT || 8080),
  redis: Number(process.env.BATSHIT_MAC_REDIS_PORT || 5639)
};
const DEFAULT_APP_ORIGIN = `http://127.0.0.1:${DEFAULT_PORTS.app}`;
const DEFAULT_SERVER_ORIGIN = `http://127.0.0.1:${DEFAULT_PORTS.server}`;
const DEFAULT_MCP_ORIGIN = `http://127.0.0.1:${DEFAULT_PORTS.mcp}`;
const DEFAULT_LIVEKIT_AGENT_NAME = 'batshit-livekit-agent';
const APPLE_CONTAINER_INSTALL_URL = 'https://github.com/apple/container/releases/latest';

const paths = {
  data:
    process.env.BATSHIT_MAC_DATA_DIR ||
    join(homedir(), 'Library', 'Application Support', 'Batshit'),
  logs: process.env.BATSHIT_MAC_LOG_DIR || join(homedir(), 'Library', 'Logs', 'Batshit'),
  cache: process.env.BATSHIT_MAC_CACHE_DIR || join(homedir(), 'Library', 'Caches', 'Batshit')
};

const runtimeDir = join(paths.data, 'runtime');
const configDir = join(paths.data, 'config');
const redisDir = join(paths.data, 'redis');
const pidDir = join(runtimeDir, 'pids');
const runtimeEnvPath = join(configDir, 'runtime.env');
const redisConfigPath = join(paths.cache, 'redis.conf');
const redisPidFile = join(pidDir, 'redis.pid');
const redisLogFile = join(paths.logs, 'redis.log');
const dockerMcpGatewayPidFile = join(pidDir, 'docker-mcp-gateway.pid');
const dockerMcpGatewayMetaFile = join(pidDir, 'docker-mcp-gateway.meta.json');
const dockerMcpGatewayLogFile = join(paths.logs, 'docker-mcp-gateway.log');
const supervisorLogFile = join(paths.logs, 'supervisor.log');
const monitorPidFile = join(pidDir, 'supervisor-monitor.pid');
const monitorStateFile = join(runtimeDir, 'supervisor-monitor.state.json');
const MONITOR_POLL_INTERVAL_MS = 5_000;
const SERVICE_STOP_GRACE_MS = 5_000;
const LOCAL_RUNTIME_LAUNCH_RECORD_NAME = '.batshit-local-runtime-launch.json';
const MONITOR_RESTART_WINDOW_MS = 10 * 60 * 1000;
const MONITOR_MAX_RESTARTS_PER_WINDOW = 5;
const MONITOR_MAX_BACKOFF_MS = 120_000;
const MONITOR_ENVIRONMENT_RETRY_MS = 30_000;
const MONITOR_SERVICE_START_GRACE_MS = 15_000;
const runtimeFingerprintPaths = [
  join(appRoot, 'build', 'index.js'),
  join(appRoot, 'build', 'server', 'manifest.js'),
  join(serverRoot, 'package.json'),
  join(serverRoot, 'src', 'index.js'),
  join(serverRoot, 'src', 'mcp', 'index.js'),
  fileURLToPath(import.meta.url),
  runtimeEnvPath
];
const macLaunchPathEntries = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
];
const dockerMcpProfilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function runtimeEnvValue(env, key) {
  if (env?.get?.(key)) return env.get(key);
  return process.env[key];
}

function parseRuntimePort(env, key, fallback) {
  const raw = runtimeEnvValue(env, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${key}: ${raw}`);
  }
  return value;
}

function runtimePorts(env = null) {
  return {
    app: parseRuntimePort(env, 'BATSHIT_FRONTEND_PORT', DEFAULT_PORTS.app),
    server: parseRuntimePort(env, 'BATSHIT_SERVER_PORT', DEFAULT_PORTS.server),
    mcp: parseRuntimePort(env, 'BATSHIT_MCP_STREAMABLE_PORT', DEFAULT_PORTS.mcp),
    dockerMcp: parseRuntimePort(env, 'DOCKER_MCP_GATEWAY_PORT', DEFAULT_PORTS.dockerMcp),
    redis: parseRuntimePort(env, 'REDIS_PORT', DEFAULT_PORTS.redis)
  };
}

function loopbackOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

function nodeRuntimeCommand() {
  return process.execPath || 'node';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function createServiceDefinitions(env = null) {
  const ports = runtimePorts(env);
  const appOrigin = loopbackOrigin(ports.app);
  const serverOrigin = loopbackOrigin(ports.server);
  const mcpOrigin = loopbackOrigin(ports.mcp);
  const nodeCommand = nodeRuntimeCommand();
  const packagedFfmpegPath = join(packagedFfmpegRoot, 'bin', 'ffmpeg');
  const packagedFfmpegEnv =
    usePackagedRuntime && existsSync(packagedFfmpegPath)
      ? {
          FFMPEG_PATH: packagedFfmpegPath,
          BATSHIT_FFMPEG_H264_ENCODER: 'h264_videotoolbox'
        }
      : {};

  return {
    batshitServer: {
      label: 'Batshit Server',
      pidFile: join(pidDir, 'batshit-server.pid'),
      metaFile: join(pidDir, 'batshit-server.meta.json'),
      logFile: join(paths.logs, 'batshit-server.log'),
      cwd: serverRoot,
      healthUrl: `${serverOrigin}/health`,
      command: nodeCommand,
      args: ['src/index.js'],
      matchCommandFragments: ['src/index.js', serverRoot],
      env: {
        ...packagedFfmpegEnv,
        LOG_LEVEL: 'info',
        PORT: String(ports.server),
        BATSHIT_SERVER_HOST: '127.0.0.1',
        ENABLE_HTTPS: 'false',
        HTTPS_ONLY: 'false',
        BATSHIT_SERVER_LOG_DIR: paths.logs
      }
    },
    mcpProxy: {
      label: 'MCP Streamable Proxy',
      pidFile: join(pidDir, 'mcp-streamable-proxy.pid'),
      metaFile: join(pidDir, 'mcp-streamable-proxy.meta.json'),
      logFile: join(paths.logs, 'mcp-streamable-proxy.log'),
      cwd: serverRoot,
      healthUrl: `${mcpOrigin}/mcp`,
      acceptableStatuses: [200, 400, 405],
      command: nodeCommand,
      args: [
        'node_modules/supergateway/dist/index.js',
        '--stdio',
        `${shellQuote(nodeCommand)} src/mcp/index.js`,
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(ports.mcp),
        '--streamableHttpPath',
        '/mcp',
        '--logLevel',
        'none'
      ],
      matchCommandFragments: ['supergateway', 'src/mcp/index.js', `--port ${ports.mcp}`]
    },
    batshitApp: {
      label: 'Batshit App',
      pidFile: join(pidDir, 'batshit-app.pid'),
      metaFile: join(pidDir, 'batshit-app.meta.json'),
      logFile: join(paths.logs, 'batshit-app.log'),
      cwd: appRoot,
      healthUrl: `${appOrigin}/`,
      acceptableStatuses: [200, 303],
      command: useProductionApp ? nodeCommand : 'npm',
      args: useProductionApp
        ? ['build']
        : ['run', 'dev', '--', '--port', String(ports.app), '--strictPort'],
      matchCommandFragments: useProductionApp
        ? ['build', appRoot]
        : ['vite', `--port ${ports.app}`, appRoot],
      env: {
        ...packagedFfmpegEnv,
        BATSHIT_LOG_DIR: paths.logs,
        ...(useProductionApp
          ? {
              NODE_ENV: 'production',
              HOST: '127.0.0.1',
              PORT: String(ports.app)
            }
          : {})
      }
    }
  }
}

function jsonResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function normalizeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function supervisorLog(scope, message) {
  try {
    await mkdir(dirname(supervisorLogFile), { recursive: true });
    await appendFile(supervisorLogFile, `[${new Date().toISOString()}] [${scope}] ${message}\n`);
  } catch (error) {
    console.error(`[supervisor] Failed to write ${supervisorLogFile}: ${normalizeError(error)}`);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirs() {
  await Promise.all([
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(redisDir, { recursive: true }),
    mkdir(pidDir, { recursive: true })
  ]);
}

function parseEnvFile(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return values;
}

async function loadRuntimeEnv() {
  if (!(await exists(runtimeEnvPath))) return new Map();
  return parseEnvFile(await readFile(runtimeEnvPath, 'utf8'));
}

function secret(length = 48) {
  return randomBytes(length).toString('base64url');
}

function redisConfigValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function ensureRuntimeEnv() {
  await ensureDirs();
  const values = await loadRuntimeEnv();
  let changed = false;
  const setIfMissing = (key, value) => {
    if (values.get(key)) return;
    values.set(key, value);
    changed = true;
  };

  setIfMissing('BATSHIT_TOKEN', secret(48));
  // Distinct secret per boundary: the Docker MCP gateway token must not reuse
  // the internal service token (G-0180).
  setIfMissing('MCP_GATEWAY_AUTH_TOKEN', secret(48));
  setIfMissing('ENCRYPTION_KEY', secret(48));
  setIfMissing('REDIS_URL', `redis://127.0.0.1:${DEFAULT_PORTS.redis}/0`);
  setIfMissing('REDIS_HOST', '127.0.0.1');
  setIfMissing('REDIS_PORT', String(DEFAULT_PORTS.redis));

  const generatedByMacRuntime =
    values.get('BATSHIT_RUNTIME_OWNER') === 'mac-app' || !values.get('BATSHIT_RUNTIME_OWNER');
  const updateOldMacDefault = (key, oldValue, newValue) => {
    if (!generatedByMacRuntime || values.get(key) !== oldValue) return;
    values.set(key, newValue);
    changed = true;
  };
  const updatePackagedPathDefault = (key, newValue, packagedPathMarker) => {
    const current = values.get(key);
    if (!current) {
      values.set(key, newValue);
      changed = true;
      return;
    }
    if (!generatedByMacRuntime || current === newValue) return;
    if (!current.includes(packagedPathMarker)) return;
    values.set(key, newValue);
    changed = true;
  };
  const oldSharedRedisDefault =
    DEFAULT_PORTS.redis !== 6379 &&
    generatedByMacRuntime &&
    values.get('REDIS_URL') === 'redis://127.0.0.1:6379/0' &&
    values.get('REDIS_HOST') === '127.0.0.1' &&
    values.get('REDIS_PORT') === '6379';
  if (oldSharedRedisDefault) {
    values.set('REDIS_URL', `redis://127.0.0.1:${DEFAULT_PORTS.redis}/0`);
    values.set('REDIS_PORT', String(DEFAULT_PORTS.redis));
    changed = true;
  }

  setIfMissing('BATSHIT_FRONTEND_PORT', String(DEFAULT_PORTS.app));
  setIfMissing('BATSHIT_SERVER_PORT', String(DEFAULT_PORTS.server));
  setIfMissing('BATSHIT_MCP_STREAMABLE_PORT', String(DEFAULT_PORTS.mcp));
  const ports = runtimePorts(values);
  const appOrigin = loopbackOrigin(ports.app);
  const serverOrigin = loopbackOrigin(ports.server);
  const dockerMcpOrigin = loopbackOrigin(ports.dockerMcp);
  setIfMissing('BATSHIT_MAC_RUNTIME_ENV_PATH', runtimeEnvPath);
  setIfMissing('BATSHIT_FRONTEND_URL', appOrigin);
  setIfMissing('PUBLIC_BASE_URL', appOrigin);
  setIfMissing('ORIGIN', appOrigin);
  setIfMissing('BATSHIT_SERVER_URL', serverOrigin);
  setIfMissing('PUBLIC_BATSHIT_SERVER_URL', serverOrigin);
  setIfMissing('PUBLIC_BATSHIT_SERVER_API_URL', `${serverOrigin}/api/v1`);
  setIfMissing('DOCKER_MCP_GATEWAY_PORT', String(ports.dockerMcp));
  setIfMissing('DOCKER_MCP_GATEWAY_URL', dockerMcpOrigin);
  setIfMissing('DOCKER_MCP_PROFILE', process.env.DOCKER_MCP_PROFILE || process.env.DOCKER_MCP_GATEWAY_PROFILE || 'default');
  setIfMissing('BODY_SIZE_LIMIT', '1G');
  setIfMissing('UPLOADS_DIR', join(paths.data, 'uploads'));
  setIfMissing('SESSION_STORAGE_PATH', join(paths.data, 'sessions'));
  setIfMissing('SESSIONS_DIR', join(paths.data, 'sessions'));
  setIfMissing('BATSHIT_RUNTIME_DATA_DIR', runtimeDir);
  setIfMissing('BATSHIT_CLOUDFLARED_DIR', join(runtimeDir, 'cloudflared'));
  setIfMissing('BATSHIT_FBX2GLTF_DIR', join(runtimeDir, 'fbx2vrma'));
  setIfMissing('LIVEKIT_VOICE_AGENT_NAME', DEFAULT_LIVEKIT_AGENT_NAME);
  if (usePackagedRuntime) {
    updatePackagedPathDefault(
      'BATSHIT_PACKAGED_RUNTIME_ROOT',
      packagedRuntimeRoot,
      '/Contents/Resources/runtime'
    );
    updatePackagedPathDefault(
      'LIVEKIT_AGENT_SOURCE_ROOT',
      packagedLiveKitSidecarSourceRoot,
      '/Contents/Resources/runtime/tools/livekit-agent-sidecar'
    );
  }
  setIfMissing('BATSHIT_BROWSER_LAUNCH_MODE', 'none');
  setIfMissing('BATSHIT_AUTO_OPEN_BATSHIT_URL', '0');
  setIfMissing('BATSHIT_AUTO_OPEN_N8N_URL', '0');
  setIfMissing('BATSHIT_RUNTIME_OWNER', 'mac-app');
  setIfMissing('BATSHIT_SKIP_N8N', '1');

  updateOldMacDefault('BATSHIT_FRONTEND_URL', `http://localhost:${DEFAULT_PORTS.app}`, appOrigin);
  updateOldMacDefault('BATSHIT_FRONTEND_URL', DEFAULT_APP_ORIGIN, appOrigin);
  updateOldMacDefault('PUBLIC_BASE_URL', `http://localhost:${DEFAULT_PORTS.app}`, appOrigin);
  updateOldMacDefault('PUBLIC_BASE_URL', DEFAULT_APP_ORIGIN, appOrigin);
  updateOldMacDefault('ORIGIN', `http://localhost:${DEFAULT_PORTS.app}`, appOrigin);
  updateOldMacDefault('ORIGIN', DEFAULT_APP_ORIGIN, appOrigin);
  updateOldMacDefault('BATSHIT_SERVER_URL', `http://localhost:${DEFAULT_PORTS.server}`, serverOrigin);
  updateOldMacDefault('BATSHIT_SERVER_URL', DEFAULT_SERVER_ORIGIN, serverOrigin);
  updateOldMacDefault('PUBLIC_BATSHIT_SERVER_URL', `http://localhost:${DEFAULT_PORTS.server}`, serverOrigin);
  updateOldMacDefault('PUBLIC_BATSHIT_SERVER_URL', DEFAULT_SERVER_ORIGIN, serverOrigin);
  updateOldMacDefault(
    'PUBLIC_BATSHIT_SERVER_API_URL',
    `http://localhost:${DEFAULT_PORTS.server}/api/v1`,
    `${serverOrigin}/api/v1`
  );
  updateOldMacDefault('PUBLIC_BATSHIT_SERVER_API_URL', `${DEFAULT_SERVER_ORIGIN}/api/v1`, `${serverOrigin}/api/v1`);
  updateOldMacDefault('DOCKER_MCP_GATEWAY_URL', `http://localhost:${DEFAULT_PORTS.dockerMcp}`, dockerMcpOrigin);
  updateOldMacDefault('DOCKER_MCP_GATEWAY_URL', `http://127.0.0.1:${DEFAULT_PORTS.dockerMcp}`, dockerMcpOrigin);
  updateOldMacDefault('BODY_SIZE_LIMIT', '600M', '1G');

  if (changed || !(await exists(runtimeEnvPath))) {
    const body = [
      '# Batshit Mac app runtime configuration.',
      '# Generated locally. Do not commit this file or paste its secrets into chat.',
      ...Array.from(values.entries()).map(([key, value]) => `${key}=${value}`)
    ].join('\n');
    await writeFile(runtimeEnvPath, `${body}\n`, { mode: 0o600 });
  }

  return values;
}

function envObject(values) {
  const env = withMacLaunchPath(process.env);
  for (const [key, value] of values.entries()) env[key] = value;
  env.PATH = mergePathEntries(env.PATH);
  return env;
}

function withMacLaunchPath(source) {
  const env = { ...source };
  env.PATH = mergePathEntries(env.PATH);
  return env;
}

function mergePathEntries(existing) {
  const packagedEntries = [];
  const packagedNodeBin = join(packagedRuntimeRoot, 'vendor', 'node', 'bin');
  const packagedRedisBin = join(packagedRedisStackRoot, 'bin');
  const packagedFfmpegBin = join(packagedFfmpegRoot, 'bin');
  for (const candidate of [packagedNodeBin, packagedRedisBin, packagedFfmpegBin]) {
    if (usePackagedRuntime && existsSync(candidate)) packagedEntries.push(candidate);
  }
  const entries = [
    ...packagedEntries,
    ...macLaunchPathEntries,
    ...String(existing || '').split(':').filter(Boolean)
  ];
  return Array.from(new Set(entries)).join(':');
}

function redactEnv(values) {
  const result = {};
  for (const [key, value] of values.entries()) {
    if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key)) {
      result[key] = value ? '[set]' : '[missing]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function run(command, args, options = {}) {
  return await new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || withMacLaunchPath(process.env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 1000).unref();
        }, options.timeoutMs)
      : null;
    timeout?.unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolveRun({ ok: false, code: 1, stdout, stderr: stderr + error.message });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolveRun({ ok: code === 0, code, signal, stdout, stderr });
    });
  });
}

async function fetchJson(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { reachable: true, ok: response.ok, status: response.status, body };
  } catch (error) {
    return { reachable: false, ok: false, status: null, error: normalizeError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function readPid(pidFile) {
  const raw = await readFile(pidFile, 'utf8').catch(() => '');
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupAlive(pgid) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pgid, signal) {
  if (!pgid) return false;
  let sent = false;
  try {
    process.kill(-pgid, signal);
    sent = true;
  } catch {
    // The process group may already be gone.
  }
  try {
    process.kill(pgid, signal);
    sent = true;
  } catch {
    // The group leader may already be gone while children remain in the group.
  }
  return sent;
}

async function wait(ms) {
  await new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function serviceState(definition) {
  const pid = await readPid(definition.pidFile);
  const pidAlive = processAlive(pid);
  const health = await fetchJson(definition.healthUrl);
  const responding =
    health.ok || Boolean(definition.acceptableStatuses?.includes(Number(health.status)));
  const requiresManagedProcess = usePackagedRuntime && definition.requiresManagedProcess !== false;
  const external = responding && !pidAlive;
  const healthy = responding && (!requiresManagedProcess || pidAlive);
  return {
    label: definition.label,
    pid,
    pidAlive,
    healthUrl: definition.healthUrl,
    healthy,
    responding,
    external,
    managed: responding && pidAlive,
    reachable: health.reachable,
    status: health.status,
    error:
      health.error ||
      (requiresManagedProcess && external
        ? `${definition.label} is already reachable on ${definition.healthUrl}, but it is not managed by the Mac app. Stop the native/dev stack or choose a different port before starting the packaged Mac runtime.`
        : null),
    response: health.body && typeof health.body === 'object' ? health.body : null,
    logFile: definition.logFile
  };
}

async function runtimeFingerprint() {
  if (!usePackagedRuntime) return 'local-checkout';
  const entries = [];
  for (const filePath of runtimeFingerprintPaths) {
    const info = await stat(filePath).catch(() => null);
    const label = filePath.startsWith(`${packagedRuntimeRoot}/`)
      ? filePath.slice(packagedRuntimeRoot.length + 1)
      : filePath;
    entries.push([
      label,
      info?.size ?? 0,
      info?.mtimeMs ?? 0
    ].join(':'));
  }
  return entries.join('|');
}

async function serviceMetadata(definition) {
  if (!definition.metaFile) return null;
  const raw = await readFile(definition.metaFile, 'utf8').catch(() => '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function serviceWithinStartGrace(metadata) {
  if (!metadata?.generatedAt) return false;
  const generatedAt = Date.parse(metadata.generatedAt);
  if (!Number.isFinite(generatedAt)) return false;
  return Date.now() - generatedAt < MONITOR_SERVICE_START_GRACE_MS;
}

async function writeServiceMetadata(definition, pid, fingerprint) {
  if (!definition.metaFile) return;
  await writeFile(
    definition.metaFile,
    `${JSON.stringify(
      {
        pid,
        fingerprint,
        appRoot,
        serverRoot,
        packagedRuntimeRoot,
        generatedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
}

async function shouldRestartForRuntimeChange(definition, current) {
  if (!usePackagedRuntime || !current.healthy || !current.pidAlive) return false;
  const currentFingerprint = await runtimeFingerprint();
  const metadata = await serviceMetadata(definition);
  return metadata?.fingerprint !== currentFingerprint;
}

async function detectCommand(command, args = ['--version']) {
  const result = await run(command, args, { timeoutMs: 5000 });
  return {
    available: result.ok,
    version: result.ok ? (result.stdout || result.stderr).trim().split('\n')[0] || null : null,
    error: result.ok ? null : (result.stderr || result.stdout || `${command} unavailable`).trim()
  };
}

async function detectNodeRuntime() {
  const command = nodeRuntimeCommand();
  const result = await run(command, ['--version'], { timeoutMs: 5000 });
  return {
    available: result.ok,
    healthy: result.ok,
    path: command,
    version: result.ok ? (result.stdout || result.stderr).trim().split('\n')[0] || null : null,
    error: result.ok ? null : (result.stderr || result.stdout || `${command} unavailable`).trim()
  };
}

async function detectNpmRuntime() {
  if (useProductionApp) {
    return {
      available: true,
      healthy: true,
      skipped: true,
      version: null,
      error: null,
      reason: 'The packaged Mac app starts runtime services with Node directly; npm is only used at build/package time.'
    };
  }
  return await detectCommand('npm');
}

async function resolvePackagedRedisStackRuntime() {
  const serverBin = join(packagedRedisStackRoot, 'bin', 'redis-server');
  const moduleDir = join(packagedRedisStackRoot, 'lib');
  try {
    await access(serverBin);
    await access(join(moduleDir, 'redisearch.so'));
    await access(join(moduleDir, 'rejson.so'));
    return { serverBin, moduleDir, source: 'packaged' };
  } catch {
    return null;
  }
}

async function resolveRedisStackRuntime() {
  if (usePackagedRuntime) {
    const packaged = await resolvePackagedRedisStackRuntime();
    if (packaged) return packaged;
  }

  const found = await run('/bin/sh', ['-lc', 'command -v redis-stack-server'], { timeoutMs: 5000 });
  const script = found.stdout.trim().split('\n')[0];
  if (!found.ok || !script) {
    throw new Error('redis-stack-server is not installed or not on PATH.');
  }

  const resolvedScript = await realpath(script);
  const baseDir = dirname(dirname(resolvedScript));
  const serverBin = join(baseDir, 'bin', 'redis-server');
  const moduleDir = join(baseDir, 'lib');
  await access(serverBin);
  await access(join(moduleDir, 'redisearch.so'));
  await access(join(moduleDir, 'rejson.so'));
  return { serverBin, moduleDir, source: 'host' };
}

function stripRedisCliValue(value) {
  return String(value || '')
    .trim()
    .replace(/^\d+\)\s*/, '')
    .replace(/^"|"$/g, '');
}

async function redisCli(env, args, timeoutMs = 2500) {
  const host = env.get('REDIS_HOST') || '127.0.0.1';
  const port = env.get('REDIS_PORT') || String(DEFAULT_PORTS.redis);
  return await run('redis-cli', ['-h', host, '-p', port, ...args], { timeoutMs });
}

function parseRedisConfigGet(stdout, key) {
  const lines = stdout
    .split(/\r?\n/)
    .map(stripRedisCliValue)
    .filter(Boolean);
  const index = lines.findIndex((line) => line.toLowerCase() === key.toLowerCase());
  if (index >= 0) return lines[index + 1] || null;
  return lines.length >= 2 ? lines[1] : null;
}

async function redisConfigGet(env, key) {
  const result = await redisCli(env, ['--raw', 'CONFIG', 'GET', key]);
  if (!result.ok) {
    return {
      value: null,
      error: (result.stderr || result.stdout || `Redis CONFIG GET ${key} failed.`).trim()
    };
  }
  return { value: parseRedisConfigGet(result.stdout, key), error: null };
}

function parseRedisInfoServer(stdout) {
  const info = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    info[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return {
    version: info.redis_version || null,
    processId: /^\d+$/.test(info.process_id || '') ? Number(info.process_id) : null
  };
}

async function redisInfoServer(env) {
  const result = await redisCli(env, ['--raw', 'INFO', 'server']);
  if (!result.ok) return { version: null, processId: null, error: (result.stderr || result.stdout).trim() };
  return { ...parseRedisInfoServer(result.stdout), error: null };
}

async function redisCommandAvailable(env, commandName) {
  const result = await redisCli(env, ['--raw', 'COMMAND', 'INFO', commandName]);
  const output = result.stdout.trim();
  return {
    available: result.ok && output.length > 0 && !/^ERR\b/i.test(output),
    error: result.ok ? null : (result.stderr || result.stdout).trim()
  };
}

async function normalizeExistingPath(value) {
  if (!value) return null;
  const resolved = resolve(value);
  return await realpath(resolved).catch(() => resolved);
}

async function listenerForPort(port) {
  const result = await run('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 3000 });
  const pid = Number(result.stdout.trim().split('\n').find(Boolean));
  if (!result.ok || !Number.isInteger(pid) || pid <= 0) return null;
  const [info] = await processRowsForPid(pid);
  return info || { pid, command: null };
}

async function redisStatus(env) {
  const host = env.get('REDIS_HOST') || '127.0.0.1';
  const port = env.get('REDIS_PORT') || String(DEFAULT_PORTS.redis);
  const trackedPid = await readPid(redisPidFile);
  const trackedPidAlive = processAlive(trackedPid);
  const result = await redisCli(env, ['PING']);
  const pingHealthy = result.stdout.trim() === 'PONG';
  const url = `redis://${host}:${port}/0`;
  const expectedDataDir = await normalizeExistingPath(redisDir);
  let configuredDataDir = null;
  let configuredPidFile = null;
  let redisVersion = null;
  let processId = null;
  let redisJson = { available: false, error: null };
  let listener = null;
  let dataDirMatches = false;
  let pidFileMatches = false;

  if (pingHealthy) {
    const [dirConfig, pidFileConfig, info, jsonCommand] = await Promise.all([
      redisConfigGet(env, 'dir'),
      redisConfigGet(env, 'pidfile'),
      redisInfoServer(env),
      redisCommandAvailable(env, 'JSON.GET')
    ]);
    configuredDataDir = await normalizeExistingPath(dirConfig.value);
    configuredPidFile = pidFileConfig.value ? resolve(pidFileConfig.value) : null;
    redisVersion = info.version;
    processId = info.processId;
    redisJson = jsonCommand;
    dataDirMatches = Boolean(configuredDataDir && expectedDataDir && configuredDataDir === expectedDataDir);
    pidFileMatches = Boolean(configuredPidFile && configuredPidFile === resolve(redisPidFile));
  } else {
    listener = await listenerForPort(port);
  }

  const processIdAlive = processAlive(processId);
  const effectivePid = trackedPidAlive ? trackedPid : processIdAlive ? processId : trackedPid || processId;
  const pidAlive = processAlive(effectivePid);
  const trackedPidMatchesRedis = Boolean(trackedPidAlive && processId && trackedPid === processId);
  const managed =
    pingHealthy && redisJson.available && (trackedPidMatchesRedis || dataDirMatches || pidFileMatches);
  const external = pingHealthy && !managed;
  const portOccupied = !pingHealthy && Boolean(listener);
  const healthy = pingHealthy && redisJson.available && managed;
  const unhealthyReason = portOccupied
    ? `Port ${port} is already in use by pid ${listener.pid}${listener.command ? ` (${listener.command})` : ''}, but it is not Batshit's Redis Stack runtime. Stop that process or change REDIS_PORT before starting Batshit.`
    : pingHealthy && !redisJson.available
      ? `Redis answered PING on ${url}, but RedisJSON is not available. Batshit needs Redis Stack 7.x or Redis with JSON support on this port.`
      : external
        ? `Redis answered on ${url}, but it is not managed by this Mac app runtime. Expected data dir ${redisDir}; actual data dir ${configuredDataDir || 'unknown'}. Stop the other Redis process or change REDIS_PORT before starting Batshit.`
        : null;

  return {
    label: 'Redis Stack',
    healthy,
    response: result.stdout.trim(),
    error:
      unhealthyReason ||
      (result.ok ? null : (result.stderr || result.stdout).trim() || 'Redis did not answer PING.'),
    url,
    healthUrl: url,
    host,
    port,
    dataDir: redisDir,
    configuredDataDir,
    configuredPidFile,
    expectedDataDir,
    version: redisVersion,
    redisJsonAvailable: redisJson.available,
    pid: effectivePid,
    trackedPid,
    trackedPidMatchesRedis,
    processId,
    pidAlive,
    managed,
    external,
    portOccupied,
    listener
  };
}

async function waitForRedisStatus(env, ms = 10_000) {
  const deadline = Date.now() + ms;
  let latest = await redisStatus(env);
  while (!latest.healthy && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    latest = await redisStatus(env);
  }
  return latest;
}

async function appleContainerStatus() {
  if (process.platform !== 'darwin') {
    return {
      label: 'Apple Container',
      available: false,
      installed: false,
      supported: false,
      healthy: false,
      version: null,
      error: 'Apple Container is only supported on macOS.',
      installUrl: APPLE_CONTAINER_INSTALL_URL
    };
  }
  const version = await run('container', ['--version'], { timeoutMs: 5000 });
  if (!version.ok) {
    return {
      label: 'Apple Container',
      available: false,
      installed: false,
      supported: true,
      healthy: false,
      version: null,
      error: 'Apple Container CLI is not installed or not on PATH.',
      installUrl: APPLE_CONTAINER_INSTALL_URL
    };
  }
  const system = await run('container', ['system', 'status'], { timeoutMs: 5000 });
  return {
    label: 'Apple Container',
    available: true,
    installed: true,
    supported: true,
    healthy: system.ok && system.stdout.includes('running'),
    version: (version.stdout || version.stderr).trim().split('\n')[0] || null,
    installUrl: APPLE_CONTAINER_INSTALL_URL,
    error:
      system.ok && system.stdout.includes('running')
        ? null
        : (system.stderr || system.stdout || 'Apple Container system is not running.').trim()
  };
}

async function startAppleContainer() {
  const before = await appleContainerStatus();
  if (!before.supported) {
    return { ok: false, skipped: true, before, error: before.error };
  }
  if (before.healthy) {
    return {
      ok: true,
      skipped: true,
      before,
      after: before,
      reason: 'Apple Container is already running.'
    };
  }

  const result = await run('container', ['system', 'start'], { timeoutMs: 120_000 });
  const after = await appleContainerStatus();
  return {
    ok: after.healthy,
    skipped: false,
    before,
    after,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: after.healthy
      ? null
      : (result.stderr || result.stdout || after.error || 'Apple Container did not become healthy.').trim()
  };
}

function dockerMcpGatewayPort(env) {
  const explicitPort = env.get('DOCKER_MCP_GATEWAY_PORT');
  if (explicitPort) {
    if (!/^\d+$/.test(explicitPort)) {
      throw new Error(`Invalid DOCKER_MCP_GATEWAY_PORT: ${explicitPort}`);
    }
    const port = Number(explicitPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid DOCKER_MCP_GATEWAY_PORT: ${explicitPort}`);
    }
    return port;
  }

  const rawUrl = env.get('DOCKER_MCP_GATEWAY_URL') || loopbackOrigin(runtimePorts(env).dockerMcp);
  try {
    const parsed = new URL(rawUrl);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port in Docker MCP Gateway URL: ${rawUrl}`);
    }
    return port;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid port')) throw error;
    throw new Error(`Invalid DOCKER_MCP_GATEWAY_URL: ${rawUrl}`);
  }
}

function dockerMcpGatewayBaseUrl(env) {
  const port = dockerMcpGatewayPort(env);
  const rawUrl = env.get('DOCKER_MCP_GATEWAY_URL') || loopbackOrigin(port);
  try {
    const parsed = new URL(rawUrl);
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin.replace(/\/+$/, '');
  } catch {
    return loopbackOrigin(port);
  }
}

function dockerMcpGatewayUrl(env) {
  return `${dockerMcpGatewayBaseUrl(env)}/mcp`;
}

function dockerMcpGatewayProfile(env) {
  const profile = (env.get('DOCKER_MCP_PROFILE') || env.get('DOCKER_MCP_GATEWAY_PROFILE') || 'default').trim();
  const normalized = profile || 'default';
  if (!dockerMcpProfilePattern.test(normalized)) {
    throw new Error(
      `Invalid DOCKER_MCP_PROFILE '${normalized}'. Use letters, numbers, dots, underscores, or hyphens.`
    );
  }
  return normalized;
}

function dockerMcpGatewayToken(env) {
  return (
    env.get('MCP_GATEWAY_AUTH_TOKEN') ||
    env.get('DOCKER_MCP_AUTH_TOKEN') ||
    env.get('DOCKER_MCP_GATEWAY_TOKEN') ||
    ''
  );
}

async function dockerRuntimeStatus() {
  const cli = await detectCommand('docker');
  if (!cli.available) {
    return {
      label: 'Docker Desktop',
      available: false,
      healthy: false,
      version: null,
      error: cli.error || 'Docker CLI is not installed or not on PATH.'
    };
  }

  const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 5000 });
  return {
    label: 'Docker Desktop',
    available: true,
    healthy: info.ok,
    version: cli.version,
    serverVersion: info.ok ? info.stdout.trim() || null : null,
    error: info.ok
      ? null
      : (info.stderr || info.stdout || 'Docker Desktop is not running.').trim()
  };
}

async function dockerMcpToolkitStatus() {
  const result = await run('docker', ['mcp', 'gateway', 'run', '--help'], { timeoutMs: 5000 });
  return {
    label: 'Docker MCP Toolkit',
    available: result.ok,
    healthy: result.ok,
    version: result.ok ? 'docker mcp gateway available' : null,
    error: result.ok
      ? null
      : (result.stderr || result.stdout || 'Docker MCP Toolkit is not available in Docker Desktop.').trim()
  };
}

async function fetchDockerMcpGatewayStatus(env) {
  const token = dockerMcpGatewayToken(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    // The URL/token come from the local Mac app runtime config and target the local Docker MCP Gateway.
    // codeql[js/file-access-to-http]
    const response = await fetch(dockerMcpGatewayUrl(env), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal
    });
    return { reachable: true, status: response.status };
  } catch (error) {
    return { reachable: false, status: null, error: normalizeError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function dockerMcpGatewayStatusIsHealthy(status) {
  return Boolean(status && [200, 202, 204, 307, 400, 405].includes(Number(status.status)));
}

async function dockerMcpGatewayStatus(env) {
  let port = null;
  let url = null;
  let profile = null;
  let tokenConfigured = false;
  try {
    port = dockerMcpGatewayPort(env);
    url = dockerMcpGatewayUrl(env);
    profile = dockerMcpGatewayProfile(env);
    tokenConfigured = Boolean(dockerMcpGatewayToken(env));
  } catch (error) {
    return {
      label: 'Docker MCP Gateway',
      optional: true,
      healthy: false,
      reachable: false,
      status: null,
      error: normalizeError(error),
      logFile: dockerMcpGatewayLogFile
    };
  }

  const pid = await readPid(dockerMcpGatewayPidFile);
  const pidAlive = processAlive(pid);
  const pidGroupAlive = processGroupAlive(pid);
  const health = await fetchDockerMcpGatewayStatus(env);
  const healthy = dockerMcpGatewayStatusIsHealthy(health);
  const authMismatch = health.status === 401 || health.status === 403;
  const wrongService = health.reachable && !healthy && !authMismatch;

  return {
    label: 'Docker MCP Gateway',
    optional: true,
    healthy,
    reachable: health.reachable,
    status: health.status,
    error:
      authMismatch
        ? 'A Docker MCP Gateway is running on this port with a different token.'
        : wrongService
          ? `Port ${port} is reachable, but it does not look like Docker MCP Gateway.`
          : health.error
            ? `Docker MCP Gateway is not listening at ${url}. Runtime Doctor starts it when Docker Desktop is running.`
            : null,
    url,
    port,
    profile,
    tokenConfigured,
    logFile: dockerMcpGatewayLogFile,
    pid,
    pidAlive,
    pidGroupAlive,
    managed: healthy && (pidAlive || pidGroupAlive),
    external: healthy && !pidAlive && !pidGroupAlive,
    authMismatch
  };
}

async function dockerMcpGatewayMetadata() {
  const raw = await readFile(dockerMcpGatewayMetaFile, 'utf8').catch(() => '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function dockerMcpGatewayNeedsRestart(env, currentStatus) {
  if (!currentStatus?.pidAlive && !currentStatus?.pidGroupAlive) return false;
  const metadata = await dockerMcpGatewayMetadata();
  if (!metadata || typeof metadata !== 'object') return true;

  const desiredPort = dockerMcpGatewayPort(env);
  const desiredProfile = dockerMcpGatewayProfile(env);
  const desiredUrl = dockerMcpGatewayUrl(env);

  return (
    Number(metadata.port) !== desiredPort ||
    metadata.profile !== desiredProfile ||
    metadata.url !== desiredUrl
  );
}

function parseProcessRows(stdout) {
  return stdout
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        ppid: Number(match[3]),
        command: match[4]
      };
    })
    .filter(Boolean);
}

function extractCommandOption(command, option) {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)([^\\s]+)`));
  return match?.[1] || null;
}

function parseDockerMcpGatewayProcess(info, groupRows = []) {
  if (!info?.command || !/\bmcp gateway run\b/.test(info.command)) return null;
  const profile = extractCommandOption(info.command, '--profile') || 'default';
  const rawPort = extractCommandOption(info.command, '--port');
  const port = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : null;
  return {
    ...info,
    profile,
    port,
    macManagedOrphan: groupRows.some((row) => row.command === 'tail -f /dev/null')
  };
}

async function processRowsForPid(pid) {
  const result = await run('ps', ['-o', 'pid=,pgid=,ppid=,command=', '-p', String(pid)], {
    timeoutMs: 3000
  });
  return result.ok ? parseProcessRows(result.stdout) : [];
}

async function processRowsForGroup(pgid) {
  const result = await run('ps', ['-o', 'pid=,pgid=,ppid=,command=', '-g', String(pgid)], {
    timeoutMs: 3000
  });
  return result.ok ? parseProcessRows(result.stdout) : [];
}

async function dockerMcpGatewayListenerProcess(port) {
  const result = await run('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 3000 });
  const pid = Number(result.stdout.trim().split('\n').find(Boolean));
  if (!result.ok || !Number.isInteger(pid) || pid <= 0) return null;
  const [info] = await processRowsForPid(pid);
  if (!info) return null;
  const groupRows = await processRowsForGroup(info.pgid);
  return parseDockerMcpGatewayProcess(info, groupRows);
}

async function dockerMcpGatewayProfileConflict(env, currentStatus) {
  if (!currentStatus?.healthy || !currentStatus.external) return null;
  const listener = await dockerMcpGatewayListenerProcess(currentStatus.port);
  if (!listener) return null;
  const desiredProfile = dockerMcpGatewayProfile(env);
  if (listener.profile === desiredProfile) return null;
  return { listener, desiredProfile };
}

async function terminateProcessGroupWithGrace(pgid, graceMs = SERVICE_STOP_GRACE_MS) {
  signalProcessGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pgid) && !processGroupAlive(pgid)) {
      return { ok: true, escalated: false, pgid };
    }
    await wait(200);
  }
  signalProcessGroup(pgid, 'SIGKILL');
  await wait(500);
  const ok = !processAlive(pgid) && !processGroupAlive(pgid);
  return { ok, escalated: true, pgid };
}

async function terminateDockerMcpGatewayGroup(pgid) {
  return terminateProcessGroupWithGrace(pgid, 2000);
}

async function stopDockerMcpGateway() {
  const pid = await readPid(dockerMcpGatewayPidFile);
  if (!pid) {
    return { skipped: true, reason: 'No Mac-managed Docker MCP Gateway pid file.' };
  }
  if (!processAlive(pid) && !processGroupAlive(pid)) {
    await rm(dockerMcpGatewayPidFile, { force: true });
    await rm(dockerMcpGatewayMetaFile, { force: true });
    return { skipped: true, reason: 'Mac-managed Docker MCP Gateway was not running.' };
  }
  const stopped = await terminateDockerMcpGatewayGroup(pid);
  if (!stopped.ok) {
    return {
      skipped: false,
      ok: false,
      pid,
      error: 'Mac-managed Docker MCP Gateway did not stop.'
    };
  }
  await rm(dockerMcpGatewayPidFile, { force: true });
  await rm(dockerMcpGatewayMetaFile, { force: true });
  return { skipped: false, ok: true, pid };
}

async function startDetachedDockerMcpGateway(env) {
  const port = dockerMcpGatewayPort(env);
  const profile = dockerMcpGatewayProfile(env);
  const token = dockerMcpGatewayToken(env);
  const args = ['mcp', 'gateway', 'run', '--port', String(port), '--transport', 'streaming'];
  if (profile) args.push('--profile', profile);

  await mkdir(dirname(dockerMcpGatewayLogFile), { recursive: true });
  await writeFile(
    dockerMcpGatewayLogFile,
    `\n\n[${new Date().toISOString()}] Starting Docker MCP Gateway on port ${port} (${profile})\n`,
    { flag: 'a' }
  );
  const log = await open(dockerMcpGatewayLogFile, 'a');
  const child = spawn('bash', ['-c', 'tail -f /dev/null | docker "$@"', '_', ...args], {
    cwd: paths.data,
    env: {
      ...envObject(env),
      MCP_GATEWAY_AUTH_TOKEN: token
    },
    detached: true,
    stdio: ['ignore', log.fd, log.fd]
  });
  child.unref();
  await log.close();
  await writeFile(dockerMcpGatewayPidFile, `${child.pid}\n`);
  await writeFile(
    dockerMcpGatewayMetaFile,
    `${JSON.stringify(
      {
        pid: child.pid,
        port,
        profile,
        url: dockerMcpGatewayUrl(env),
        generatedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
  return child.pid;
}

async function waitForDockerMcpGateway(env, ms = 15_000) {
  const deadline = Date.now() + ms;
  let latest = await dockerMcpGatewayStatus(env);
  while (!latest.healthy && !latest.authMismatch && Date.now() < deadline) {
    await wait(500);
    latest = await dockerMcpGatewayStatus(env);
  }
  return latest;
}

async function waitForDockerMcpGatewayStopped(env, ms = 5000) {
  const deadline = Date.now() + ms;
  let latest = await dockerMcpGatewayStatus(env);
  while (latest.reachable && Date.now() < deadline) {
    await wait(250);
    latest = await dockerMcpGatewayStatus(env);
  }
  return latest;
}

async function ensureDockerMcpGateway(env) {
  const token = dockerMcpGatewayToken(env);
  if (!token) {
    return {
      skipped: true,
      ok: false,
      error: 'MCP_GATEWAY_AUTH_TOKEN is missing from the Mac runtime environment.'
    };
  }

  const [docker, toolkit] = await Promise.all([dockerRuntimeStatus(), dockerMcpToolkitStatus()]);
  if (!docker.available || !docker.healthy) {
    return {
      skipped: true,
      ok: false,
      error: docker.error || 'Docker Desktop is not running.',
      docker
    };
  }
  if (!toolkit.available) {
    return {
      skipped: true,
      ok: false,
      error: toolkit.error || 'Docker MCP Toolkit is not available.',
      toolkit
    };
  }

  let before = await dockerMcpGatewayStatus(env);
  const staleManagedGateway = before.healthy
    ? await dockerMcpGatewayNeedsRestart(env, before)
    : false;
  const externalProfileConflict =
    before.healthy && !staleManagedGateway
      ? await dockerMcpGatewayProfileConflict(env, before)
      : null;
  if (before.healthy && !staleManagedGateway && !externalProfileConflict) {
    return {
      skipped: true,
      ok: true,
      reason: before.external
        ? 'Docker MCP Gateway is already running with the Mac runtime token.'
        : 'Docker MCP Gateway already healthy.',
      status: before
    };
  }
  if (staleManagedGateway) {
    const stopResult = await stopDockerMcpGateway();
    if (stopResult.ok === false) {
      return {
        skipped: true,
        ok: false,
        error: stopResult.error,
        status: before
      };
    }
    before = await waitForDockerMcpGatewayStopped(env);
    if (before.reachable) {
      return {
        skipped: true,
        ok: false,
        error:
          `The old Mac-managed Docker MCP Gateway on port ${before.port} did not stop cleanly; profile '${dockerMcpGatewayProfile(env)}' could not be applied.`,
        status: before
      };
    }
  } else if (externalProfileConflict) {
    const { listener, desiredProfile } = externalProfileConflict;
    if (!listener.macManagedOrphan) {
      return {
        skipped: true,
        ok: false,
        error:
          `A Docker MCP Gateway is already running on port ${before.port} with profile '${listener.profile}', but Batshit is configured for profile '${desiredProfile}'. Stop that gateway or choose the matching profile.`,
        status: before
      };
    }
    const stopped = await terminateDockerMcpGatewayGroup(listener.pgid);
    before = await waitForDockerMcpGatewayStopped(env);
    if (!stopped.ok || before.reachable) {
      return {
        skipped: true,
        ok: false,
        error:
          `The stale Mac-managed Docker MCP Gateway on port ${before.port} did not stop cleanly; profile '${desiredProfile}' could not be applied.`,
        status: before
      };
    }
  }
  if (before.authMismatch) {
    return {
      skipped: true,
      ok: false,
      error:
        `A Docker MCP Gateway is already running on port ${before.port} with a different token. Stop that gateway or change the Mac runtime Docker MCP Gateway port.`,
      status: before
    };
  }
  if (before.reachable) {
    return {
      skipped: true,
      ok: false,
      error:
        `Port ${before.port} is already in use, but it did not respond like Docker MCP Gateway.`,
      status: before
    };
  }

  await stopDockerMcpGateway();
  const pid = await startDetachedDockerMcpGateway(env);
  const after = await waitForDockerMcpGateway(env);
  if (!after.healthy) {
    return {
      skipped: false,
      ok: false,
      pid,
      error: after.error || 'Docker MCP Gateway did not become reachable.',
      status: after
    };
  }
  return { skipped: false, ok: true, pid, status: after };
}

async function status() {
  await ensureDirs();
  const env = await ensureRuntimeEnv();
  const serviceDefinitions = createServiceDefinitions(env);
  const [
    node,
    npm,
    redisCli,
    redis,
    ffmpeg,
    appleContainer,
    docker,
    dockerMcpToolkit,
    dockerMcpGateway,
    server,
    mcp,
    app,
    monitor
  ] =
    await Promise.all([
      detectNodeRuntime(),
      detectNpmRuntime(),
      detectCommand('redis-cli', ['--version']),
      redisStatus(env),
      detectCommand('ffmpeg', ['-version']),
      appleContainerStatus(),
      dockerRuntimeStatus(),
      dockerMcpToolkitStatus(),
      dockerMcpGatewayStatus(env),
      serviceState(serviceDefinitions.batshitServer),
      serviceState(serviceDefinitions.mcpProxy),
      serviceState(serviceDefinitions.batshitApp),
      monitorStatus()
    ]);
  const appUrl = env.get('BATSHIT_FRONTEND_URL') || DEFAULT_APP_ORIGIN;
  const healthy = redis.healthy && server.healthy && mcp.healthy && app.healthy;

  return {
    ok: healthy,
    generatedAt: new Date().toISOString(),
    appUrl,
    paths,
    runtimeEnvPath,
    runtimeEnv: redactEnv(env),
    tools: { node, npm, redisCli, ffmpeg, appleContainer, docker, dockerMcpToolkit },
    services: {
      redis,
      batshitServer: server,
      mcpProxy: mcp,
      batshitApp: app,
      dockerMcpGateway
    },
    monitor,
    releaseNotes: {
      n8n: 'Mac app runtime does not bundle n8n. Connect an existing n8n instance when needed.',
      voice:
        'Voice engines are connect-existing/manual unless a specific approved runtime recipe exists.',
      packaging:
        'Public Mac releases are distributed as Developer ID signed, notarized, stapled DMGs. Local development .app builds may still use local/ad-hoc signing.',
      runtime: usePackagedRuntime
        ? 'Supervisor is using the runtime payload packaged inside Batshit.app.'
        : 'Supervisor is using the local checkout runtime payload.'
    }
  };
}

function doctorAdvice(report) {
  const actions = [];
  if (!report.tools.node.available) {
    actions.push({
      id: 'node-missing',
      severity: 'blocker',
      title: 'Node.js is missing',
      detail:
        usePackagedRuntime
          ? 'The packaged Mac app is missing its app-owned Node.js runtime. Reinstall Batshit or use a package built with the managed Node runtime.'
          : 'The source-checkout Mac runtime starts the Batshit app/server with Node.js 24.'
    });
  }
  if (!report.tools.npm.available) {
    actions.push({
      id: 'npm-missing',
      severity: 'blocker',
      title: 'npm is missing',
      detail: 'npm is required to start the local Batshit app and server from this checkout.'
    });
  }
  if (!report.tools.redisCli.available) {
    actions.push({
      id: 'redis-cli-missing',
      severity: 'blocker',
      title: 'Redis CLI is missing',
      detail:
        usePackagedRuntime
          ? 'The packaged Mac app is missing app-owned redis-cli. Reinstall Batshit or use a package built with the managed Redis Stack runtime.'
          : 'The Mac runtime doctor uses redis-cli to verify Redis Stack readiness.'
    });
  }
  if (!report.services.redis.healthy) {
    actions.push({
      id: 'redis-stopped',
      severity: report.services.redis.portOccupied || report.services.redis.external ? 'blocker' : 'repairable',
      title:
        report.services.redis.portOccupied || report.services.redis.external
          ? 'Redis port is not Batshit-owned'
          : 'Redis Stack is not ready',
      detail:
        report.services.redis.error ||
        (usePackagedRuntime
          ? 'Start Runtime will try to launch Batshit-managed Redis Stack with app-owned data storage.'
          : 'Start Runtime will try to launch redis-stack-server with Batshit-owned data storage.')
    });
  } else if (report.services.redis.external) {
    actions.push({
      id: 'redis-external',
      severity: 'blocker',
      title: 'Redis Stack is external',
      detail:
        report.services.redis.error ||
        'Runtime Doctor reached Redis, but this Mac app did not start it. Stop the other Redis process or change the Mac runtime Redis port before starting Batshit.'
    });
  }
  if (!report.services.batshitServer.healthy) {
    actions.push({
      id: 'server-stopped',
      severity: 'repairable',
      title: 'Batshit Server is not healthy',
      detail: 'Start Runtime will launch batshit-server and write its logs under ~/Library/Logs/Batshit.'
    });
  }
  if (!report.services.batshitApp.healthy) {
    actions.push({
      id: 'app-stopped',
      severity: 'repairable',
      title: 'Batshit app is not healthy',
      detail: 'Start Runtime will launch the SvelteKit app on the Mac app port.'
    });
  }
  if (!report.tools.ffmpeg.available) {
    actions.push({
      id: 'ffmpeg-missing',
      severity: 'warning',
      title: 'FFmpeg is not available',
      detail:
        usePackagedRuntime
          ? 'Motion and Goon preview transcoding need FFmpeg. The package does not include an app-owned FFmpeg runtime yet, so chat can run but media preview workflows may fail.'
          : 'Motion and Goon preview transcoding need FFmpeg. Chat can still run without it.'
    });
  }
  if (!report.tools.appleContainer.available) {
    actions.push({
      id: 'apple-container-missing',
      severity: 'warning',
      title: 'Apple Container is not installed',
      detail:
        'Apple Container is the default Mac sandbox for Agent Mode. Install Apple’s signed package, then return here and start the Apple Container system.',
      externalUrl: APPLE_CONTAINER_INSTALL_URL,
      externalLabel: 'Install Apple Container'
    });
  } else if (!report.tools.appleContainer.healthy) {
    actions.push({
      id: 'apple-container-stopped',
      severity: 'warning',
      title: 'Apple Container sandbox is not ready',
      detail:
        'Apple Container is the default Mac sandbox for Agent Mode. Apple-backed Bash runs will fail clearly until Apple Container is installed and running. Docker Sandbox remains available as an explicit agent setting.',
      repairCommand: 'appleContainerStart',
      repairLabel: 'Start Apple Container'
    });
  }
  if (!report.tools.docker.available) {
    actions.push({
      id: 'docker-missing',
      severity: 'warning',
      title: 'Docker Desktop is not available',
      detail:
        'Docker MCP Gateway tools need Docker Desktop with MCP Toolkit. Core Batshit can still run without Docker.'
    });
  } else if (!report.tools.docker.healthy) {
    actions.push({
      id: 'docker-stopped',
      severity: 'warning',
      title: 'Docker Desktop is not running',
      detail:
        'Start Docker Desktop, then restart the Mac runtime so Runtime Doctor can launch Docker MCP Gateway with Batshit’s generated token.'
    });
  } else if (!report.tools.dockerMcpToolkit.available) {
    actions.push({
      id: 'docker-mcp-toolkit-missing',
      severity: 'warning',
      title: 'Docker MCP Toolkit is not available',
      detail:
        'Docker MCP Gateway needs the Docker MCP Toolkit commands from Docker Desktop. Core Batshit can still run without Docker MCP tools.'
    });
  } else if (!report.services.dockerMcpGateway.healthy) {
    actions.push({
      id: 'docker-mcp-gateway-stopped',
      severity: 'warning',
      title: 'Docker MCP Gateway is not ready',
      detail:
        report.services.dockerMcpGateway.error ||
        'Restart the Mac runtime so Runtime Doctor can launch Docker MCP Gateway with the generated gateway token.'
    });
  }
  const managedServices = [
    report.services.batshitServer,
    report.services.mcpProxy,
    report.services.batshitApp
  ];
  if (report.monitor && !report.monitor.running && managedServices.some((service) => service?.pidAlive)) {
    actions.push({
      id: 'runtime-monitor-stopped',
      severity: 'warning',
      title: 'Runtime crash monitor is not running',
      detail:
        'Crashed runtime services will stay dead instead of auto-restarting. Restart the runtime to bring the monitor back.'
    });
  }
  for (const [key, service] of Object.entries(report.monitor?.state?.services || {})) {
    if (!service?.failed) continue;
    actions.push({
      id: `${key}-crash-loop`,
      severity: 'blocker',
      title: `${service.label || key} keeps crashing`,
      detail:
        `Auto-restart gave up after repeated crashes. Check ${service.logFile || 'the service log'} and ` +
        `${report.monitor.logFile}, then restart the runtime.`
    });
  }
  return actions;
}

async function startRedis(env) {
  const redis = await redisStatus(env);
  if (redis.healthy) return { skipped: true, ok: true, reason: 'Redis already healthy.' };
  if (redis.portOccupied || redis.external || redis.response === 'PONG') {
    return {
      skipped: true,
      ok: false,
      error:
        redis.error ||
        `Redis port ${redis.port} is already in use by a process that is not Batshit's managed Redis Stack runtime.`,
      status: redis
    };
  }
  await mkdir(redisDir, { recursive: true });
  const redisRuntime = await resolveRedisStackRuntime();
  const redisHost = env.get('REDIS_HOST') || '127.0.0.1';
  const redisPort = env.get('REDIS_PORT') || String(DEFAULT_PORTS.redis);
  const config = [
    `bind ${redisHost}`,
    `port ${redisPort}`,
    'protected-mode yes',
    `dir ${redisConfigValue(redisDir)}`,
    `pidfile ${redisConfigValue(redisPidFile)}`,
    `logfile ${redisConfigValue(redisLogFile)}`,
    'daemonize yes'
  ].join('\n');
  await writeFile(redisConfigPath, `${config}\n`, { mode: 0o600 });
  const result = await run(
    redisRuntime.serverBin,
    [
      redisConfigPath,
      '--dir',
      redisDir,
      '--protected-mode',
      'yes',
      '--daemonize',
      'yes',
      '--loadmodule',
      join(redisRuntime.moduleDir, 'rediscompat.so'),
      '--loadmodule',
      join(redisRuntime.moduleDir, 'redisearch.so'),
      'MAXSEARCHRESULTS',
      '10000',
      'MAXAGGREGATERESULTS',
      '10000',
      '--loadmodule',
      join(redisRuntime.moduleDir, 'redistimeseries.so'),
      '--loadmodule',
      join(redisRuntime.moduleDir, 'rejson.so'),
      '--loadmodule',
      join(redisRuntime.moduleDir, 'redisbloom.so'),
      '--loadmodule',
      join(redisRuntime.moduleDir, 'redisgears.so'),
      'v8-plugin-path',
      join(redisRuntime.moduleDir, 'libredisgears_v8_plugin.so')
    ],
    { timeoutMs: 10000 }
  );
  const after = await waitForRedisStatus(env);
  if (!after.healthy) {
    return {
      skipped: false,
      ok: false,
      error:
        after.error ||
        (result.stderr || result.stdout).trim() ||
        'redis-stack-server did not start. Install Redis Stack or use Docker.'
    };
  }
  return { skipped: false, ok: true, pid: after.pid, dataDir: after.dataDir };
}

async function spawnService(definition, env, options = {}) {
  const current = await serviceState(definition);
  if (usePackagedRuntime && current.external) {
    return {
      skipped: true,
      ok: false,
      reason: current.error,
      error: current.error,
      healthUrl: current.healthUrl,
      status: current
    };
  }
  if (await shouldRestartForRuntimeChange(definition, current)) {
    await stopService(definition);
  } else if (current.healthy && current.pidAlive) {
    return { skipped: true, reason: `${definition.label} already healthy.`, pid: current.pid };
  }

  const fingerprint = await runtimeFingerprint();
  const afterStop = current.healthy && current.pidAlive
    ? await serviceState(definition)
    : current;
  if (afterStop.healthy && afterStop.pidAlive) {
    return { skipped: true, reason: `${definition.label} already healthy.`, pid: afterStop.pid };
  }
  await mkdir(dirname(definition.logFile), { recursive: true });
  await writeFile(
    definition.logFile,
    `\n\n[${new Date().toISOString()}] Starting ${definition.label}\n`,
    { flag: 'a' }
  );
  // stdio wiring: fd 1 (stdout) and fd 2 (stderr) both append to the per-service log file,
  // so a dying child always leaves its final output there.
  const log = await open(definition.logFile, 'a');
  const serviceEnv = { ...env, ...(definition.env || {}) };
  const child = spawn(definition.command, definition.args, {
    cwd: definition.cwd,
    env: serviceEnv,
    detached: true,
    stdio: ['ignore', log.fd, log.fd]
  });
  const spawnError = await new Promise((resolveSpawn) => {
    child.once('spawn', () => resolveSpawn(null));
    child.once('error', (error) => resolveSpawn(error));
  });
  await log.close();
  if (spawnError || !child.pid) {
    const message = `${definition.label} failed to spawn: ${
      spawnError ? normalizeError(spawnError) : 'no pid was assigned'
    }`;
    await supervisorLog('spawn', message);
    // The log file is a Batshit-owned runtime log path, not a user-selected file target.
    // codeql[js/file-system-race]
    await writeFile(definition.logFile, `[${new Date().toISOString()}] ${message}\n`, { flag: 'a' });
    return { skipped: false, ok: false, error: message, logFile: definition.logFile };
  }
  // While the spawning process is still alive (one-shot start window, or the resident
  // monitor), record the real exit code/signal so crashes are never silent.
  child.once('exit', (code, signal) => {
    void supervisorLog(
      'exit',
      `${definition.label} (pid ${child.pid}) exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
    );
    options.onExit?.({ pid: child.pid, code, signal });
  });
  child.unref();
  await writeFile(definition.pidFile, `${child.pid}\n`);
  await writeServiceMetadata(definition, child.pid, fingerprint);
  await supervisorLog('spawn', `Started ${definition.label} (pid ${child.pid}).`);
  return { skipped: false, ok: true, pid: child.pid, logFile: definition.logFile };
}

async function waitForRuntime(ms = 30_000) {
  const deadline = Date.now() + ms;
  let latest = await status();
  while (Date.now() < deadline) {
    if (latest.ok) {
      return latest;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    latest = await status();
  }
  return latest;
}

async function start() {
  const env = await ensureRuntimeEnv();
  const serviceDefinitions = createServiceDefinitions(env);
  const fullEnv = envObject(env);
  await supervisorLog('start', `Runtime start requested (packaged=${usePackagedRuntime}).`);
  // Stop any previous monitor before touching services so it cannot race the
  // fingerprint-driven stop/respawn below; a fresh monitor is spawned after.
  await stopMonitor();
  // Kill leftovers from a previous unclean quit before starting fresh services.
  // Running healthy services (and their live cloudflared tunnels) are not touched,
  // and already-running voice engines stay up for auto-start to reuse.
  const sweep = await sweepOrphans('start', env, serviceDefinitions);
  const appleContainer = await startAppleContainer();
  const redis = await startRedis(env);
  if (redis.ok === false) {
    const report = await status();
    return {
      ok: false,
      sweep,
      started: {
        appleContainer,
        redis,
        dockerMcpGateway: { skipped: true, reason: 'Redis is not ready.' },
        batshitServer: { skipped: true, reason: 'Redis is not ready.' },
        mcpProxy: { skipped: true, reason: 'Redis is not ready.' },
        batshitApp: { skipped: true, reason: 'Redis is not ready.' },
        monitor: { skipped: true, reason: 'Redis is not ready.' }
      },
      status: report
    };
  }
  const dockerMcpGateway = await ensureDockerMcpGateway(env);
  const server = await spawnService(serviceDefinitions.batshitServer, fullEnv);
  const mcp = await spawnService(serviceDefinitions.mcpProxy, fullEnv);
  const app = await spawnService(serviceDefinitions.batshitApp, fullEnv);
  const monitor = await spawnMonitor(env);
  const report = await waitForRuntime();
  return {
    ok: report.ok,
    sweep,
    started: {
      appleContainer,
      redis,
      dockerMcpGateway,
      batshitServer: server,
      mcpProxy: mcp,
      batshitApp: app,
      monitor
    },
    status: report
  };
}

async function stopService(definition) {
  const pid = await readPid(definition.pidFile);
  if (!pid) return { skipped: true, reason: `${definition.label} has no pid file.` };
  if (!processAlive(pid) && !processGroupAlive(pid)) {
    await rm(definition.pidFile, { force: true });
    await rm(definition.metaFile, { force: true });
    return { skipped: true, reason: `${definition.label} was not running.` };
  }
  const group = await processGroupMatchesTrackedEntry(definition, pid);
  if (!group.rows.length || !group.matches) {
    await rm(definition.pidFile, { force: true });
    await rm(definition.metaFile, { force: true });
    const reason = `${definition.label} pid ${pid} no longer matches its launch metadata (likely pid reuse); refused to kill it.`;
    await supervisorLog('stop', reason);
    return { skipped: true, reason, pid, commands: group.rows.map((row) => row.command) };
  }
  // Services are spawned detached, so the recorded pid leads a process group that
  // contains every non-detached descendant (npm -> node, the batshit-server MCP
  // child, managed cloudflared tunnels). Stop the whole group, with a grace
  // window before SIGKILL so the services can run their own shutdown handlers.
  const stopped = await terminateProcessGroupWithGrace(pid);
  if (!stopped.ok) {
    await supervisorLog('stop', `${definition.label} (pgid ${pid}) did not stop after SIGKILL.`);
    return {
      skipped: false,
      ok: false,
      pid,
      error: `${definition.label} process group did not stop.`
    };
  }
  if (stopped.escalated) {
    await supervisorLog('stop', `${definition.label} (pgid ${pid}) needed SIGKILL escalation.`);
  }
  await rm(definition.pidFile, { force: true });
  await rm(definition.metaFile, { force: true });
  return { skipped: false, ok: true, pid, escalated: stopped.escalated };
}

function expandHomePath(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

// Mirrors the batshit-app resolver in voiceLocalEngineSetup.ts: detached local
// runtimes (voice engines, native LiveKit server, LiveKit sidecar) write a
// launch record under this root on every spawn so the supervisor can stop them.
function voiceRuntimeStateRoot(env = null) {
  const configured =
    env?.get?.('BATSHIT_VOICE_RUNTIME_STATE_ROOT') || process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT;
  if (typeof configured === 'string' && configured.trim()) {
    return resolve(expandHomePath(configured.trim()));
  }
  return join(homedir(), '.batshit', 'runtime', 'voice-engines');
}

function launchRecordMatchesCommand(record, commandLine) {
  // cwd matters: shell-style launches record a bare command ("npm"), but every
  // process in the runtime's tree carries the absolute install path in its argv.
  const absoluteCandidates = [
    record.command,
    record.cwd,
    ...(Array.isArray(record.args) ? record.args : [])
  ].filter((value) => typeof value === 'string' && value.startsWith('/'));
  if (absoluteCandidates.some((candidate) => commandLine.includes(candidate))) return true;
  const base = typeof record.command === 'string' ? record.command.split('/').pop() : '';
  return Boolean(base) && commandLine.includes(base);
}

function processGroupMatchesFragments(rows, fragments = []) {
  const usable = fragments.filter((fragment) => typeof fragment === 'string' && fragment.trim());
  if (!usable.length) return false;
  return rows.some((row) => usable.some((fragment) => row.command.includes(fragment)));
}

async function processGroupRowsForPid(pgid) {
  return (await processRowsForGroup(pgid)).filter((row) => row.pgid === pgid);
}

async function processGroupMatchesTrackedEntry(entry, pgid) {
  const rows = await processGroupRowsForPid(pgid);
  const matches = processGroupMatchesFragments(rows, entry.matchCommandFragments);
  return { rows, matches };
}

async function readLocalRuntimeLaunchRecords(env = null) {
  const root = voiceRuntimeStateRoot(env);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const recordPath = join(root, entry.name, LOCAL_RUNTIME_LAUNCH_RECORD_NAME);
    const raw = await readFile(recordPath, 'utf8').catch(() => '');
    if (!raw) continue;
    try {
      records.push({ engineId: entry.name, ...JSON.parse(raw), recordPath });
    } catch {
      records.push({ engineId: entry.name, invalid: true, recordPath });
    }
  }
  return records;
}

async function stopManagedLocalRuntimes(env = null) {
  const results = [];
  for (const record of await readLocalRuntimeLaunchRecords(env)) {
    const label = `Local runtime "${record.engineId}"`;
    if (record.invalid || !Number.isInteger(record.pid) || record.pid <= 0) {
      await rm(record.recordPath, { force: true });
      const reason = `${label} launch record was invalid; removed it.`;
      await supervisorLog('stop', reason);
      results.push({ engineId: record.engineId, skipped: true, reason });
      continue;
    }
    if (!processAlive(record.pid) && !processGroupAlive(record.pid)) {
      await rm(record.recordPath, { force: true });
      results.push({ engineId: record.engineId, skipped: true, reason: `${label} was not running.` });
      continue;
    }
    // Detached runtimes lead their own process group (pgid == launch pid). Only
    // kill when at least one current group member still matches the recorded
    // launch command, so a reused pid never takes down an innocent process.
    const groupRows = (await processRowsForGroup(record.pid)).filter(
      (row) => row.pgid === record.pid
    );
    const matches = groupRows.some((row) => launchRecordMatchesCommand(record, row.command));
    if (!groupRows.length || !matches) {
      await rm(record.recordPath, { force: true });
      const reason = `${label} pid ${record.pid} no longer matches its launch record (likely pid reuse); refused to kill it.`;
      await supervisorLog('stop', reason);
      results.push({ engineId: record.engineId, skipped: true, reason });
      continue;
    }
    const stopped = await terminateProcessGroupWithGrace(record.pid);
    if (!stopped.ok) {
      const error = `${label} (pgid ${record.pid}) did not stop after SIGKILL.`;
      await supervisorLog('stop', error);
      results.push({ engineId: record.engineId, ok: false, pid: record.pid, error });
      continue;
    }
    await rm(record.recordPath, { force: true });
    await supervisorLog('stop', `Stopped ${label} (pgid ${record.pid}).`);
    results.push({ engineId: record.engineId, ok: true, pid: record.pid, escalated: stopped.escalated });
  }
  return results;
}

// Orphan sweep: kill process-group stragglers whose pid-file leader died (an
// unclean quit leaves the batshit-server MCP child, cloudflared tunnels, and
// npm/node trees behind) plus stale managed cloudflared tunnels whose parent
// group is gone. Live, healthy services and their groups are never touched.
async function sweepOrphans(phase, env = null, serviceDefinitions = createServiceDefinitions(env)) {
  const cleaned = [];
  const issues = [];
  const liveGroups = new Set();

  const tracked = [
    ...Object.values(serviceDefinitions).map((definition) => ({
      label: definition.label,
      pidFile: definition.pidFile,
      metaFile: definition.metaFile,
      matchCommandFragments: definition.matchCommandFragments
    })),
    {
      label: 'Docker MCP Gateway',
      pidFile: dockerMcpGatewayPidFile,
      metaFile: dockerMcpGatewayMetaFile,
      matchCommandFragments: ['docker mcp gateway run', 'mcp gateway run', `--port ${dockerMcpGatewayPort(env)}`]
    }
  ];

  for (const entry of tracked) {
    const pid = await readPid(entry.pidFile);
    if (!pid) continue;
    if (processAlive(pid)) {
      liveGroups.add(pid);
      continue;
    }
    if (!processGroupAlive(pid)) continue;
    const { rows, matches } = await processGroupMatchesTrackedEntry(entry, pid);
    if (!rows.length || !matches) {
      await rm(entry.pidFile, { force: true });
      await rm(entry.metaFile, { force: true });
      cleaned.push({
        type: 'stale-pidfile-pid-reuse',
        label: entry.label,
        pgid: pid,
        commands: rows.map((row) => row.command)
      });
      await supervisorLog(
        'sweep',
        `${entry.label} pid file pointed at process group ${pid}, but current commands no longer match; removed stale pid metadata without killing the group.`
      );
      continue;
    }
    const stopped = await terminateProcessGroupWithGrace(pid);
    const detail = {
      type: 'service-group-stragglers',
      label: entry.label,
      pgid: pid,
      commands: rows.map((row) => row.command),
      ok: stopped.ok
    };
    if (stopped.ok) {
      await rm(entry.pidFile, { force: true });
      await rm(entry.metaFile, { force: true });
      cleaned.push(detail);
      await supervisorLog(
        'sweep',
        `Killed orphaned ${entry.label} process group ${pid} (${rows.length} straggler(s)).`
      );
    } else {
      issues.push(detail);
      await supervisorLog('sweep', `Orphaned ${entry.label} process group ${pid} did not stop.`);
    }
  }

  // Stale standalone Cloudflared cleanup is intentionally limited to the Mac
  // runtime's managed install directory. Native/source-checkout tunnels may use
  // the same loopback ports during side-by-side testing, so target URL alone is
  // not ownership proof.
  const ps = await run('ps', ['-axo', 'pid=,pgid=,ppid=,command='], { timeoutMs: 5000 });
  if (ps.ok) {
    const ports = [runtimePorts(env).server, runtimePorts(env).app];
    const macCloudflaredDir = resolve(
      env?.get?.('BATSHIT_CLOUDFLARED_DIR') || join(runtimeDir, 'cloudflared')
    );
    const staleTunnels = parseProcessRows(ps.stdout).filter((row) => {
      if (!/\bcloudflared\b/.test(row.command) || !/\btunnel\b/.test(row.command)) return false;
      if (!row.command.includes(macCloudflaredDir)) return false;
      const target = extractCommandOption(row.command, '--url');
      if (!target) return false;
      return ports.some((port) =>
        new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(/|$)`).test(target)
      );
    });
    for (const tunnel of staleTunnels) {
      if (liveGroups.has(tunnel.pgid)) continue;
      try {
        process.kill(tunnel.pid, 'SIGTERM');
      } catch {
        continue;
      }
      await wait(500);
      if (processAlive(tunnel.pid)) {
        try {
          process.kill(tunnel.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      cleaned.push({ type: 'stale-cloudflared', pid: tunnel.pid, command: tunnel.command });
      await supervisorLog('sweep', `Killed stale cloudflared tunnel (pid ${tunnel.pid}): ${tunnel.command}`);
    }
  } else {
    issues.push({ type: 'ps-failed', error: (ps.stderr || '').trim() || 'ps returned no process rows.' });
    await supervisorLog('sweep', 'Orphan sweep could not list processes; stale cloudflared check skipped.');
  }

  if (cleaned.length || issues.length) {
    await supervisorLog(
      'sweep',
      `Orphan sweep (${phase}) cleaned ${cleaned.length} item(s) with ${issues.length} issue(s).`
    );
  }
  return { phase, cleaned, issues };
}

async function stopRedis(env = null) {
  const runtimeEnv = env || await loadRuntimeEnv();
  const current = await redisStatus(runtimeEnv);
  const trackedPid = await readPid(redisPidFile);
  const trackedPidAlive = processAlive(trackedPid);
  let pid = trackedPid;
  if ((!pid || !trackedPidAlive) && current.managed && current.pid && processAlive(current.pid)) {
    pid = current.pid;
  }
  if (!pid) {
    return { skipped: true, reason: 'Redis was external or already running before Batshit started.' };
  }
  if (!processAlive(pid)) {
    await rm(redisPidFile, { force: true });
    return { skipped: true, reason: 'Mac-managed Redis was not running.' };
  }
  const safeTrackedProcess = trackedPidAlive && pid === trackedPid && !current.external;
  if (!current.managed && !safeTrackedProcess) {
    await rm(redisPidFile, { force: true });
    return {
      skipped: true,
      ok: false,
      reason:
        current.error ||
        `Redis on ${current.url} is not managed by this Mac app runtime; refused to stop pid ${pid}.`,
      pid
    };
  }
  process.kill(pid, 'SIGTERM');
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  if (processAlive(pid)) process.kill(pid, 'SIGKILL');
  await rm(redisPidFile, { force: true });
  return { skipped: false, ok: true, pid };
}

// --- Runtime monitor ---------------------------------------------------------
// The supervisor script itself is one-shot (the Mac app invokes `start`/`stop`/
// `status` and the process exits), so long-lived children used to die with no
// witness: nothing logged their exit and nothing restarted them. `start` now
// spawns a detached resident `monitor-daemon` (this same script) that polls the
// pid files, logs every death/restart to supervisor.log, and respawns dead
// children with exponential backoff and a hard cap. No silent behavior.

function monitorBackoffDelay(attemptsInWindow) {
  if (attemptsInWindow <= 0) return 0;
  return Math.min(MONITOR_MAX_BACKOFF_MS, 5_000 * 2 ** (attemptsInWindow - 1));
}

async function readMonitorState() {
  const raw = await readFile(monitorStateFile, 'utf8').catch(() => '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function monitorStatus() {
  const pid = await readPid(monitorPidFile);
  return {
    label: 'Runtime Monitor',
    running: processAlive(pid),
    pid,
    logFile: supervisorLogFile,
    stateFile: monitorStateFile,
    pollIntervalMs: MONITOR_POLL_INTERVAL_MS,
    state: await readMonitorState()
  };
}

async function stopMonitor() {
  const pid = await readPid(monitorPidFile);
  if (!pid) return { skipped: true, reason: 'Runtime monitor has no pid file.' };
  if (!processAlive(pid)) {
    await rm(monitorPidFile, { force: true });
    return { skipped: true, reason: 'Runtime monitor was not running.' };
  }
  await supervisorLog('monitor', `Stopping runtime monitor (pid ${pid}).`);
  process.kill(pid, 'SIGTERM');
  await wait(500);
  if (processAlive(pid)) process.kill(pid, 'SIGKILL');
  await rm(monitorPidFile, { force: true });
  return { skipped: false, ok: true, pid };
}

async function spawnMonitor(env) {
  // Always replace any previous monitor so it runs current code with fresh state.
  await stopMonitor();
  await mkdir(dirname(supervisorLogFile), { recursive: true });
  const log = await open(supervisorLogFile, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'monitor-daemon'], {
    cwd: repoRoot,
    env: envObject(env),
    detached: true,
    stdio: ['ignore', log.fd, log.fd]
  });
  const spawnError = await new Promise((resolveSpawn) => {
    child.once('spawn', () => resolveSpawn(null));
    child.once('error', (error) => resolveSpawn(error));
  });
  await log.close();
  if (spawnError || !child.pid) {
    const message = `Runtime monitor failed to spawn: ${
      spawnError ? normalizeError(spawnError) : 'no pid was assigned'
    }`;
    await supervisorLog('monitor', message);
    return { skipped: false, ok: false, error: message, logFile: supervisorLogFile };
  }
  child.unref();
  await writeFile(monitorPidFile, `${child.pid}\n`);
  await supervisorLog('monitor', `Started runtime monitor (pid ${child.pid}).`);
  return { skipped: false, ok: true, pid: child.pid, logFile: supervisorLogFile };
}

async function runMonitorDaemon() {
  await ensureDirs();
  const env = await loadRuntimeEnv();
  const serviceDefinitions = createServiceDefinitions(env);
  const existingPid = await readPid(monitorPidFile);
  if (existingPid && existingPid !== process.pid && processAlive(existingPid)) {
    await supervisorLog(
      'monitor',
      `Another runtime monitor is already running (pid ${existingPid}); duplicate (pid ${process.pid}) is exiting.`
    );
    return;
  }
  await writeFile(monitorPidFile, `${process.pid}\n`);

  const monitoredServices = [
    { key: 'batshitServer', kind: 'service', definition: serviceDefinitions.batshitServer },
    { key: 'mcpProxy', kind: 'service', definition: serviceDefinitions.mcpProxy },
    { key: 'batshitApp', kind: 'service', definition: serviceDefinitions.batshitApp },
    { key: 'redis', kind: 'redis', label: 'Redis Stack', logFile: redisLogFile },
    {
      key: 'dockerMcpGateway',
      kind: 'docker-mcp-gateway',
      label: 'Docker MCP Gateway',
      logFile: dockerMcpGatewayLogFile,
      optional: true
    }
  ];
  const states = new Map(
    monitoredServices.map((service) => [
      service.key,
      {
        label: service.definition?.label || service.label,
        logFile: service.definition?.logFile || service.logFile,
        optional: Boolean(service.optional),
        failed: false,
        restartTimes: [],
        totalRestarts: 0,
        nextAttemptAt: 0,
        lastExit: null,
        lastIssue: null,
        lastRestartAt: null
      }
    ])
  );
  const startedAt = new Date().toISOString();
  let stateDirty = true;
  let shuttingDown = false;

  const writeStateFile = async () => {
    const services = {};
    for (const [key, state] of states.entries()) {
      services[key] = {
        label: state.label,
        logFile: state.logFile,
        optional: state.optional,
        failed: state.failed,
        totalRestarts: state.totalRestarts,
        restartsInWindow: state.restartTimes.length,
        lastExit: state.lastExit,
        lastIssue: state.lastIssue,
        lastRestartAt: state.lastRestartAt
      };
    }
    await writeFile(
      monitorStateFile,
      `${JSON.stringify(
        { monitorPid: process.pid, startedAt, updatedAt: new Date().toISOString(), services },
        null,
        2
      )}\n`
    );
  };

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await supervisorLog('monitor', `Runtime monitor stopping (pid ${process.pid}, ${signal}).`);
    const recordedPid = await readPid(monitorPidFile);
    if (recordedPid === process.pid) await rm(monitorPidFile, { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('uncaughtException', (error) => {
    void supervisorLog('monitor', `Uncaught exception (monitor stays up): ${normalizeError(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    void supervisorLog('monitor', `Unhandled rejection (monitor stays up): ${normalizeError(reason)}`);
  });

  const noteIssue = async (state, issue) => {
    if (state.lastIssue === issue) return;
    state.lastIssue = issue;
    stateDirty = true;
    if (issue) await supervisorLog('monitor', `${state.label}: ${issue}`);
  };

  const markAlive = async (state) => {
    if (state.failed) {
      state.failed = false;
      state.restartTimes = [];
      state.nextAttemptAt = 0;
      stateDirty = true;
      await supervisorLog(
        'monitor',
        `${state.label} is alive again after being marked failed; monitoring resumed.`
      );
    }
    if (state.lastIssue) await noteIssue(state, null);
  };

  const markFailedIfCapped = async (state, now) => {
    state.restartTimes = state.restartTimes.filter(
      (time) => now - time < MONITOR_RESTART_WINDOW_MS
    );
    if (state.restartTimes.length < MONITOR_MAX_RESTARTS_PER_WINDOW) return false;
    state.failed = true;
    stateDirty = true;
    await supervisorLog(
      'monitor',
      `[FAILED] ${state.label} died ${MONITOR_MAX_RESTARTS_PER_WINDOW} times within ` +
        `${Math.round(MONITOR_RESTART_WINDOW_MS / 60_000)} minutes. Auto-restart is disabled for ` +
        `this service until the runtime is restarted. Check ${state.logFile} and ${supervisorLogFile}.`
    );
    return true;
  };

  const recordAttempt = (state, now) => {
    state.restartTimes.push(now);
    state.totalRestarts += 1;
    state.lastRestartAt = new Date().toISOString();
    state.nextAttemptAt = now + monitorBackoffDelay(state.restartTimes.length);
    stateDirty = true;
  };

  const logDeath = async (state, deadPid) => {
    const exitDetail =
      state.lastExit && state.lastExit.pid === deadPid
        ? `exit code=${state.lastExit.code ?? 'null'}, signal=${state.lastExit.signal ?? 'null'}`
        : 'exit details unavailable (process was not spawned by this monitor)';
    await supervisorLog(
      'monitor',
      `${state.label} (pid ${deadPid}) is dead (${exitDetail}). ` +
        `Restart attempt ${state.restartTimes.length + 1}/${MONITOR_MAX_RESTARTS_PER_WINDOW}.`
    );
  };

  const handleDeadService = async (service, state, deadPid, env) => {
    const now = Date.now();
    if (state.failed || now < state.nextAttemptAt) return;
    if (await markFailedIfCapped(state, now)) return;
    await logDeath(state, deadPid);
    // A dead leader can strand process-group members (cloudflared tunnels, the
    // batshit-server MCP child); kill them before respawning a fresh group.
    if (service.kind === 'service' && deadPid && processGroupAlive(deadPid)) {
      const group = await processGroupMatchesTrackedEntry(service.definition, deadPid);
      if (!group.rows.length || !group.matches) {
        await supervisorLog(
          'monitor',
          `Dead ${state.label} pid ${deadPid} no longer matches its launch metadata; removed stale pid metadata without killing the process group.`
        );
        await rm(service.definition.pidFile, { force: true });
        await rm(service.definition.metaFile, { force: true });
      } else {
        const straggler = await terminateProcessGroupWithGrace(deadPid, 2000);
        await supervisorLog(
          'monitor',
          straggler.ok
            ? `Cleaned up stragglers from dead ${state.label} process group ${deadPid}.`
            : `Stragglers from dead ${state.label} process group ${deadPid} did not stop.`
        );
      }
    }
    recordAttempt(state, now);

    let result;
    if (service.kind === 'redis') {
      const startResult = await startRedis(env);
      result = startResult.ok
        ? { ok: true, pid: startResult.pid }
        : {
            ok: false,
            pid: null,
            error: startResult.error || 'Redis did not restart.'
          };
    } else {
      const spawnResult = await spawnService(service.definition, envObject(env), {
        onExit: (exit) => {
          state.lastExit = { ...exit, at: new Date().toISOString() };
          stateDirty = true;
        }
      });
      result = {
        ok: Boolean(spawnResult.ok || (spawnResult.skipped && !spawnResult.error)),
        pid: spawnResult.pid ?? null,
        error: spawnResult.error || spawnResult.reason || `${state.label} did not restart.`
      };
    }
    if (result.ok) {
      await supervisorLog('monitor', `${state.label} restarted (pid ${result.pid ?? 'unknown'}).`);
      await noteIssue(state, null);
    } else {
      await supervisorLog(
        'monitor',
        `${state.label} restart failed: ${result.error || 'unknown error'} ` +
          `Next attempt in ${Math.round(monitorBackoffDelay(state.restartTimes.length) / 1000)}s.`
      );
    }
  };

  const handleUnhealthyLiveService = async (service, state, current, env) => {
    const now = Date.now();
    if (state.failed || now < state.nextAttemptAt) return;
    if (await markFailedIfCapped(state, now)) return;

    const pid = current.pid;
    await supervisorLog(
      'monitor',
      `${state.label} (pid ${pid}) is alive but unhealthy (${current.error || 'health check failed'}). ` +
        `Restart attempt ${state.restartTimes.length + 1}/${MONITOR_MAX_RESTARTS_PER_WINDOW}.`
    );

    if (pid && processGroupAlive(pid)) {
      const group = await processGroupMatchesTrackedEntry(service.definition, pid);
      if (!group.rows.length || !group.matches) {
        await supervisorLog(
          'monitor',
          `Unhealthy ${state.label} pid ${pid} no longer matches its launch metadata; removed stale pid metadata without killing the process group.`
        );
        await rm(service.definition.pidFile, { force: true });
        await rm(service.definition.metaFile, { force: true });
      } else {
        const stopped = await terminateProcessGroupWithGrace(pid, 2000);
        await supervisorLog(
          'monitor',
          stopped.ok
            ? `Stopped unhealthy ${state.label} process group ${pid}.`
            : `Unhealthy ${state.label} process group ${pid} did not stop cleanly.`
        );
      }
    }

    recordAttempt(state, now);
    const spawnResult = await spawnService(service.definition, envObject(env), {
      onExit: (exit) => {
        state.lastExit = { ...exit, at: new Date().toISOString() };
        stateDirty = true;
      }
    });
    const result = {
      ok: Boolean(spawnResult.ok || (spawnResult.skipped && !spawnResult.error)),
      pid: spawnResult.pid ?? null,
      error: spawnResult.error || spawnResult.reason || `${state.label} did not restart.`
    };

    if (result.ok) {
      await supervisorLog('monitor', `${state.label} restarted (pid ${result.pid ?? 'unknown'}).`);
      await noteIssue(state, null);
    } else {
      await supervisorLog(
        'monitor',
        `${state.label} restart failed: ${result.error || 'unknown error'} ` +
          `Next attempt in ${Math.round(monitorBackoffDelay(state.restartTimes.length) / 1000)}s.`
      );
    }
  };

  const handleDeadGateway = async (state, deadPid, env) => {
    const now = Date.now();
    if (state.failed || now < state.nextAttemptAt) return;
    if (await markFailedIfCapped(state, now)) return;

    const result = await ensureDockerMcpGateway(env);
    if (result.skipped && !result.ok) {
      // Environment is not ready (Docker Desktop down, external conflict, missing
      // token). Not a crash-restart attempt; report it and recheck periodically.
      state.nextAttemptAt = now + MONITOR_ENVIRONMENT_RETRY_MS;
      await noteIssue(
        state,
        `gateway (pid ${deadPid}) is down and cannot restart yet: ${
          result.error || result.reason || 'environment not ready'
        }`
      );
      return;
    }
    if (result.skipped && result.ok) {
      // An external gateway answered with the Mac runtime token; clear the stale
      // Mac-managed pid records and stop watching it.
      await rm(dockerMcpGatewayPidFile, { force: true });
      await rm(dockerMcpGatewayMetaFile, { force: true });
      await supervisorLog(
        'monitor',
        `${state.label} (pid ${deadPid}) died, but an external gateway is serving the port. ` +
          'Cleared the stale Mac-managed pid records.'
      );
      await noteIssue(state, null);
      return;
    }
    await logDeath(state, deadPid);
    recordAttempt(state, now);
    if (result.ok) {
      await supervisorLog('monitor', `${state.label} restarted (pid ${result.pid ?? 'unknown'}).`);
      await noteIssue(state, null);
    } else {
      await supervisorLog(
        'monitor',
        `${state.label} restart failed: ${result.error || 'unknown error'} ` +
          `Next attempt in ${Math.round(monitorBackoffDelay(state.restartTimes.length) / 1000)}s.`
      );
    }
  };

  const tick = async () => {
    const env = await ensureRuntimeEnv();
    for (const service of monitoredServices) {
      const state = states.get(service.key);
      try {
        if (service.kind === 'service') {
          const pid = await readPid(service.definition.pidFile);
          if (!pid) {
            await noteIssue(
              state,
              'has no pid file; the monitor leaves it alone until the runtime starts it.'
            );
            continue;
          }
          const pidAlive = processAlive(pid);
          if (pidAlive) {
            const current = await serviceState(service.definition);
            if (current.healthy) {
              await markAlive(state);
              continue;
            }
            const metadata = await serviceMetadata(service.definition);
            if (serviceWithinStartGrace(metadata)) {
              await noteIssue(
                state,
                `pid ${pid} is alive but ${service.definition.healthUrl} is not ready yet; still inside startup grace.`
              );
              continue;
            }
            await handleUnhealthyLiveService(service, state, current, env);
            continue;
          }
          await handleDeadService(service, state, pid, env);
          continue;
        }
        if (service.kind === 'redis') {
          const pid = await readPid(redisPidFile);
          if (!pid) {
            await noteIssue(
              state,
              'has no Mac-managed pid file (external or stopped); the monitor leaves it alone.'
            );
            continue;
          }
          if (processAlive(pid)) {
            await markAlive(state);
            continue;
          }
          const current = await redisStatus(env);
          if (current.healthy) {
            await noteIssue(
              state,
              `pid file points at dead pid ${pid}, but Redis still answers PING; leaving it alone.`
            );
            continue;
          }
          await handleDeadService(service, state, pid, env);
          continue;
        }
        const pid = await readPid(dockerMcpGatewayPidFile);
        if (!pid) {
          await noteIssue(state, null);
          continue;
        }
        if (processAlive(pid) || processGroupAlive(pid)) {
          await markAlive(state);
          continue;
        }
        await handleDeadGateway(state, pid, env);
      } catch (error) {
        await supervisorLog(
          'monitor',
          `${state.label}: monitor pass failed: ${normalizeError(error)}`
        );
      }
    }
    if (stateDirty) {
      stateDirty = false;
      try {
        await writeStateFile();
      } catch (error) {
        await supervisorLog('monitor', `Failed to write ${monitorStateFile}: ${normalizeError(error)}`);
      }
    }
  };

  await supervisorLog(
    'monitor',
    `Runtime monitor started (pid ${process.pid}, poll ${MONITOR_POLL_INTERVAL_MS}ms, ` +
      `cap ${MONITOR_MAX_RESTARTS_PER_WINDOW} restarts/${Math.round(MONITOR_RESTART_WINDOW_MS / 60_000)}min, ` +
      `packaged=${usePackagedRuntime}). Watching: ${Array.from(states.values())
        .map((state) => state.label)
        .join(', ')}.`
  );
  await writeStateFile().catch(async (error) => {
    await supervisorLog('monitor', `Failed to write ${monitorStateFile}: ${normalizeError(error)}`);
  });
  while (!shuttingDown) {
    await tick();
    await wait(MONITOR_POLL_INTERVAL_MS);
  }
}

async function stop() {
  await supervisorLog('stop', 'Runtime stop requested.');
  const env = await loadRuntimeEnv();
  const serviceDefinitions = createServiceDefinitions(env);
  // Order matters: the monitor must die first so it cannot respawn services,
  // and the app must stop before managed local runtimes so it cannot relaunch
  // a voice engine mid-stop. The final sweep catches any stragglers.
  const results = {
    monitor: await stopMonitor(),
    batshitApp: await stopService(serviceDefinitions.batshitApp),
    localRuntimes: await stopManagedLocalRuntimes(env),
    mcpProxy: await stopService(serviceDefinitions.mcpProxy),
    batshitServer: await stopService(serviceDefinitions.batshitServer),
    dockerMcpGateway: await stopDockerMcpGateway(),
    redis: await stopRedis(env),
    sweep: await sweepOrphans('stop', env, serviceDefinitions)
  };
  const ok =
    ![results.batshitApp, results.mcpProxy, results.batshitServer, results.dockerMcpGateway, results.redis].some(
      (result) => result && result.ok === false
    ) &&
    !results.localRuntimes.some((result) => result.ok === false) &&
    results.sweep.issues.length === 0;
  return { ok, stopped: results, status: await status() };
}

async function packageAudit(packagePath) {
  const target = resolve(packagePath || join(macRoot, 'zig-out', 'package'));
  const realTarget = await realpath(target).catch(() => null);
  const foundSecrets = [];
  const suspiciousPaths = [];
  const missingRuntimeFiles = [];
  const invalidIcons = [];
  const chromiumCefIssues = [];
  const privacyIssues = [];
  const requiredRuntimeFiles = [
    'Contents/Resources/THIRD_PARTY_NOTICES.md',
    'Contents/Resources/runtime/batshit-app/package.json',
    'Contents/Resources/runtime/batshit-app/build/index.js',
    'Contents/Resources/runtime/batshit-server/server/package.json',
    'Contents/Resources/runtime/batshit-server/server/src/index.js',
    'Contents/Resources/runtime/batshit-server/server/node_modules/async/log.js'
  ];
  const disallowedRuntimePaths = [
    'Contents/Resources/runtime/batshit-app/node_modules/.cache',
    'Contents/Resources/runtime/batshit-app/node_modules/.tmp',
    'Contents/Resources/runtime/batshit-app/node_modules/.vite',
    'Contents/Resources/runtime/batshit-app/node_modules/.vite-temp',
    'Contents/Resources/runtime/batshit-server/server/node_modules/.cache',
    'Contents/Resources/runtime/batshit-server/server/node_modules/.tmp',
    'Contents/Resources/runtime/batshit-server/server/node_modules/.vite',
    'Contents/Resources/runtime/batshit-server/server/node_modules/.vite-temp'
  ];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
        continue;
      }
      const relative = realTarget ? full.slice(realTarget.length + 1) : full;
      if (/runtime\.env|\.env$|\.log$|terminal-current\.log|console-current\.log/i.test(relative)) {
        suspiciousPaths.push(relative);
      }
      if (/icon\.icns$/i.test(entry.name)) {
        const info = await stat(full).catch(() => null);
        if (!info || info.size < 1024) invalidIcons.push(relative);
      }
      if (!/\.(html|js|json|plist|txt|md|env)$/i.test(entry.name)) continue;
      const text = await readFile(full, 'utf8').catch(() => '');
      if (
        /\b(BATSHIT_TOKEN|ENCRYPTION_KEY|N8N_API_KEY|OPENAI_API_KEY)=(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,})\b/i.test(
          text
        )
      ) {
        foundSecrets.push(relative);
      }
    }
  }

  if (!realTarget || !(await stat(realTarget).catch(() => null))) {
    return { ok: false, packagePath: target, error: 'Package path does not exist.' };
  }
  await walk(realTarget);
  for (const relative of requiredRuntimeFiles) {
    if (!(await stat(join(realTarget, relative)).catch(() => null))) {
      missingRuntimeFiles.push(relative);
    }
  }
  for (const relative of disallowedRuntimePaths) {
    if (await stat(join(realTarget, relative)).catch(() => null)) {
      suspiciousPaths.push(relative);
    }
  }

  const infoPlist = await readFile(join(realTarget, 'Contents', 'Info.plist'), 'utf8').catch(
    () => ''
  );
  if (!infoPlist.includes('<key>NSMicrophoneUsageDescription</key>')) {
    privacyIssues.push(
      'Info.plist is missing NSMicrophoneUsageDescription, so macOS microphone permission prompts and WKWebView microphone capture are not launch-safe.'
    );
  }
  if (!infoPlist.includes('<key>NSSpeechRecognitionUsageDescription</key>')) {
    privacyIssues.push(
      'Info.plist is missing NSSpeechRecognitionUsageDescription, so Browser speech-to-text can fail inside WKWebView even when microphone capture is allowed.'
    );
  }
  const isChromiumPackage =
    infoPlist.includes('ai.batshit.mac.chromium') || /Chromium\.app$/i.test(realTarget);
  if (isChromiumPackage) {
    const frameworksDir = join(realTarget, 'Contents', 'Frameworks');
    const frameworkEntries = await readdir(frameworksDir, { withFileTypes: true }).catch(() => []);
    const helperApps = frameworkEntries.filter(
      (entry) => entry.isDirectory() && /helper.*\.app$/i.test(entry.name)
    );
    if (helperApps.length === 0) {
      chromiumCefIssues.push(
        'Chromium/CEF package is missing hidden macOS helper app bundles in Contents/Frameworks. This packaging shape launches CEF subprocesses through the visible app executable, which opens blank windows and extra Dock icons. Do not ship this artifact until helper packaging is implemented.'
      );
    }
  }

  return {
    ok:
      foundSecrets.length === 0 &&
      suspiciousPaths.length === 0 &&
      missingRuntimeFiles.length === 0 &&
      invalidIcons.length === 0 &&
      chromiumCefIssues.length === 0 &&
      privacyIssues.length === 0,
    packagePath: realTarget,
    foundSecrets,
    suspiciousPaths,
    missingRuntimeFiles,
    invalidIcons,
    chromiumCefIssues,
    privacyIssues
  };
}

async function main() {
  const action = process.argv[2] || 'status';
  try {
    if (action === 'status') {
      jsonResponse({ success: true, ...(await status()) });
      return;
    }
    if (action === 'doctor') {
      const report = await status();
      jsonResponse({ success: true, ...report, actions: doctorAdvice(report) });
      return;
    }
    if (action === 'start') {
      jsonResponse({ success: true, ...(await start()) });
      return;
    }
    if (action === 'stop') {
      jsonResponse({ success: true, ...(await stop()) });
      return;
    }
    if (action === 'restart') {
      await stop();
      jsonResponse({ success: true, ...(await start()) });
      return;
    }
    if (action === 'monitor-daemon') {
      // Resident loop spawned detached by `start`; stdout/stderr go to
      // supervisor.log, never to the one-shot JSON contract on stdout.
      await runMonitorDaemon();
      return;
    }
    if (action === 'sweep') {
      const env = await loadRuntimeEnv();
      const sweep = await sweepOrphans('manual', env, createServiceDefinitions(env));
      jsonResponse({ success: true, ok: sweep.issues.length === 0, sweep });
      return;
    }
    if (action === 'apple-container-start') {
      const result = await startAppleContainer();
      const report = await status();
      jsonResponse({ success: true, ok: result.ok, appleContainer: result, status: report });
      return;
    }
    if (action === 'package-audit') {
      const audit = await packageAudit(process.argv[3]);
      jsonResponse({ success: audit.ok, audit });
      if (!audit.ok) process.exitCode = 1;
      return;
    }
    throw new Error(`Unknown supervisor action: ${action}`);
  } catch (error) {
    jsonResponse({ success: false, ok: false, error: normalizeError(error) });
    process.exitCode = 1;
  }
}

await main();
