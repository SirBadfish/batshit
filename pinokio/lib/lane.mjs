// The Pinokio lane: its fixed ports, its data folder, and the exact environment each Batshit
// process runs with (SA-127 DL-05, DL-06). Pure functions, so the tests can pin every value.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// A fixed lane, not "the next free port": Batshit's sign-in cookie and its CSRF check are tied
// to one origin, so a port that moves would sign the user out. A taken port is a clear error.
export const LANE_HOST = '127.0.0.1';
export const LANE_PORTS = Object.freeze({ app: 5650, server: 5651, redis: 5659 });

// Two Batshit lanes on one computer share the browser's cookie jar for 127.0.0.1, so this lane
// needs its own cookie name or each would sign the other out on every page load.
export const LANE_SESSION_COOKIE = 'batshit_session_pinokio';
export const LANE_RUNTIME_OWNER = 'pinokio';
export const LANE_LAUNCH_PROFILE_ENV = 'BATSHIT_PINOKIO_LAUNCH_PROFILE';

function validateLaunchProfile(profile) {
  if (profile !== 'native' && profile !== 'windows-wsl') {
    throw new Error('Unknown Pinokio launch profile; expected native or windows-wsl.');
  }
  return profile;
}

// An owned Windows launcher/proof opts in; Linux alone never selects this policy. This is
// runtime compatibility validation, not caller authentication or Windows support acceptance.
export function resolveLaunchProfile({ env, platform }) {
  const value = env[LANE_LAUNCH_PROFILE_ENV];
  const profile = validateLaunchProfile(value === undefined ? 'native' : value);
  if (profile === 'windows-wsl' && platform !== 'linux') {
    throw new Error('The windows-wsl Pinokio launch profile requires a Linux guest.');
  }
  return profile;
}

export const SECRET_KEYS = ['BATSHIT_TOKEN', 'ENCRYPTION_KEY'];

// Everything the user owns lives here, outside the Pinokio folder, so Pinokio's Reset and
// Update never touch it (DL-05). Only "Delete Batshit data" removes it.
export function laneDataRoot(home = homedir()) {
  return join(home, '.batshit', 'pinokio');
}

export function laneDataPaths(dataRoot) {
  const root = resolve(dataRoot);
  const runtime = join(root, 'runtime');
  const logs = join(root, 'logs');
  return {
    root,
    secretsFile: join(root, 'batshit.env'),
    redis: join(root, 'redis'),
    uploads: join(root, 'uploads'),
    backupStaging: join(root, 'backup-restore-staging'),
    logs,
    // Redis writes its log here, not to Pinokio's terminal (BL-363); the start before keeps its
    // log as the previous one.
    redisLog: join(logs, 'redis.log'),
    redisPreviousLog: join(logs, 'redis.previous.log'),
    runtime,
    installs: join(root, 'installs'),
    voiceEngines: join(runtime, 'voice-engines'),
    appleContainer: join(runtime, 'apple-container'),
    sbxDaemon: join(runtime, 'sbx-daemon')
  };
}

// Folders created at install and checked at every start.
export function laneDataFolders(paths) {
  return [
    paths.root,
    paths.redis,
    paths.uploads,
    paths.backupStaging,
    paths.logs,
    paths.runtime,
    paths.installs,
    paths.voiceEngines
  ];
}

export function generateSecrets(random = randomBytes) {
  return {
    BATSHIT_TOKEN: random(48).toString('base64url'),
    ENCRYPTION_KEY: random(48).toString('base64url')
  };
}

export function parseEnvText(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

export function formatSecretsFile(secrets) {
  return [
    '# Batshit (Pinokio) secrets. Generated once at install; never change them.',
    '# ENCRYPTION_KEY unlocks the API keys you save in Batshit: if it changes, they cannot be read.',
    '# Do not share this file or paste it into a chat.',
    ...SECRET_KEYS.map((key) => `${key}=${secrets[key]}`),
    ''
  ].join('\n');
}

// Returns the problems with a secrets file's values; an empty list means usable. The app
// refuses keys shorter than 32 characters or still set to a template placeholder.
export function secretProblems(values) {
  const problems = [];
  for (const key of SECRET_KEYS) {
    const value = values[key] || '';
    if (!value) problems.push(`${key} is missing`);
    else if (value.length < 32 || value.startsWith('replace-with-')) problems.push(`${key} is not a usable secret`);
  }
  return problems;
}

// Variables that would switch Batshit into another lane's behavior if they leaked in from the
// environment Pinokio starts us with.
const FOREIGN_LANE_KEYS = [
  'BATSHIT_CONTAINERIZED',
  'BATSHIT_RUNTIME_ENV',
  'BATSHIT_MAC_RUNTIME_ENV_PATH',
  'CONFIG_PATH',
  'DOCKER_MCP_GATEWAY_URL',
  'DOCKER_MCP_GATEWAY_PORT',
  'MCP_GATEWAY_AUTH_TOKEN'
];

// Which Batshit launched a voice engine, as the app stamps it on the engine's launch record
// (`launchedBy`). Stable across starts, so a later start knows an earlier start's engines as its
// own (BL-343).
export function laneVoiceRuntimeOwner(paths) {
  return `${LANE_RUNTIME_OWNER}:${paths.root}`;
}

// The environment shared by batshit-server and the app. Every URL names this lane's own ports;
// the code's fallbacks name the Mac app's (5600/5620) or the native lane's Redis (6379).
export function sharedLaneEnv({ paths, secrets }) {
  const appOrigin = `http://${LANE_HOST}:${LANE_PORTS.app}`;
  const serverOrigin = `http://${LANE_HOST}:${LANE_PORTS.server}`;
  return {
    NODE_ENV: 'production',
    REDIS_URL: `redis://${LANE_HOST}:${LANE_PORTS.redis}/0`,
    REDIS_HOST: LANE_HOST,
    REDIS_PORT: String(LANE_PORTS.redis),
    BATSHIT_TOKEN: secrets.BATSHIT_TOKEN,
    ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
    BATSHIT_RUNTIME_OWNER: LANE_RUNTIME_OWNER,
    BATSHIT_SESSION_COOKIE_NAME: LANE_SESSION_COOKIE,
    ORIGIN: appOrigin,
    PUBLIC_BASE_URL: appOrigin,
    BATSHIT_FRONTEND_URL: appOrigin,
    CORS_ORIGIN: appOrigin,
    BATSHIT_ARTIFACT_COMPLETE_URL: `${appOrigin}/api/artifacts/complete`,
    BATSHIT_SERVER_URL: serverOrigin,
    BATSHIT_SERVER_API_URL: `${serverOrigin}/api/v1`,
    PUBLIC_BATSHIT_SERVER_URL: serverOrigin,
    PUBLIC_BATSHIT_SERVER_API_URL: `${serverOrigin}/api/v1`,
    BODY_SIZE_LIMIT: '1G',
    UPLOADS_DIR: paths.uploads,
    BATSHIT_BACKUP_STAGING_DIR: paths.backupStaging,
    BATSHIT_SERVER_LOG_DIR: paths.logs,
    BATSHIT_LOG_DIR: paths.logs,
    BATSHIT_RUNTIME_DATA_DIR: paths.runtime,
    BATSHIT_MANAGED_INSTALLS_ROOT: paths.installs,
    BATSHIT_VOICE_RUNTIME_STATE_ROOT: paths.voiceEngines,
    BATSHIT_VOICE_RUNTIME_OWNER: laneVoiceRuntimeOwner(paths),
    BATSHIT_APPLE_CONTAINER_STATE_DIR: paths.appleContainer,
    BATSHIT_SBX_DAEMON_STATE_DIR: paths.sbxDaemon,
    // Pinokio's Update button is this lane's update path; the in-app check would point at the
    // Mac download and call GitHub (DL-07: nothing phones home).
    BATSHIT_UPDATE_CHECK_DISABLED: '1'
  };
}

export function serverEnv(shared) {
  return {
    ...shared,
    PORT: String(LANE_PORTS.server),
    BATSHIT_SERVER_HOST: LANE_HOST,
    ENABLE_HTTPS: 'false',
    HTTPS_ONLY: 'false',
    BATSHIT_REDIS_REQUIRED: 'true',
    LOG_LEVEL: 'info'
  };
}

export function appEnv(shared) {
  // adapter-node listens on every network interface and port 3000 unless told otherwise.
  return { ...shared, HOST: LANE_HOST, PORT: String(LANE_PORTS.app) };
}

// The process environment a service starts with: Pinokio's own (its PATH holds Node, git, and
// ffmpeg), minus anything that would switch lanes, plus the lane's values, which always win.
export function childEnv(baseEnv, laneValues) {
  const env = { ...baseEnv };
  for (const key of FOREIGN_LANE_KEYS) delete env[key];
  return { ...env, ...laneValues };
}

// redis-server arguments for the lane. Append-only from the first start, so a fresh data
// folder never holds a snapshot-only dataset (the BL-111 trap), and the two modules Batshit
// needs are loaded explicitly: redis-server refuses to start when one cannot be loaded. Its log
// goes to a file: Start waits for one line in Pinokio's terminal, and Redis's own output after
// "Ready to accept connections" could push that line out of what Pinokio reads (BL-363).
export function redisServerArgs({ redisDir, moduleDir, modules, logFile, launchProfile = 'native' }) {
  const durableSaves = validateLaunchProfile(launchProfile) === 'windows-wsl';
  return [
    '--port', String(LANE_PORTS.redis),
    '--bind', LANE_HOST,
    '--protected-mode', 'yes',
    '--dir', redisDir,
    '--appendonly', 'yes',
    '--appendfsync', durableSaves ? 'always' : 'everysec',
    ...(durableSaves ? ['--no-appendfsync-on-rewrite', 'no'] : []),
    '--aof-use-rdb-preamble', 'yes',
    '--daemonize', 'no',
    '--logfile', logFile,
    ...modules.flatMap((name) => ['--loadmodule', join(moduleDir, name)]),
    '--search-max-search-results', '10000',
    '--search-max-aggregate-results', '10000'
  ];
}
