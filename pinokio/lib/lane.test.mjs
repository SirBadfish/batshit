import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appEnv,
  childEnv,
  formatSecretsFile,
  generateSecrets,
  LANE_LAUNCH_PROFILE_ENV,
  LANE_PORTS,
  LANE_SESSION_COOKIE,
  laneDataFolders,
  laneDataPaths,
  laneDataRoot,
  laneVoiceRuntimeOwner,
  parseEnvText,
  redisServerArgs,
  resolveLaunchProfile,
  secretProblems,
  serverEnv,
  sharedLaneEnv
} from './lane.mjs';

const paths = laneDataPaths('/home/ada/.batshit/pinokio');
const secrets = { BATSHIT_TOKEN: 't'.repeat(40), ENCRYPTION_KEY: 'k'.repeat(40) };
const shared = sharedLaneEnv({ paths, secrets });

test('the lane owns ports 5650, 5651, and 5659 (DL-06)', () => {
  assert.deepEqual({ ...LANE_PORTS }, { app: 5650, server: 5651, redis: 5659 });
});

test('data lives under ~/.batshit/pinokio, outside the launcher folder (DL-05)', () => {
  assert.equal(laneDataRoot('/home/ada'), '/home/ada/.batshit/pinokio');
  for (const folder of laneDataFolders(paths)) assert.ok(folder.startsWith(paths.root), folder);
  for (const key of [
    'UPLOADS_DIR',
    'BATSHIT_BACKUP_STAGING_DIR',
    'BATSHIT_SERVER_LOG_DIR',
    'BATSHIT_LOG_DIR',
    'BATSHIT_RUNTIME_DATA_DIR',
    'BATSHIT_MANAGED_INSTALLS_ROOT',
    'BATSHIT_VOICE_RUNTIME_STATE_ROOT',
    'BATSHIT_APPLE_CONTAINER_STATE_DIR',
    'BATSHIT_SBX_DAEMON_STATE_DIR'
  ]) {
    assert.ok(shared[key].startsWith(`${paths.root}/`), `${key}=${shared[key]}`);
  }
});

test('every address names this lane, never the Mac app (5620/5600) or the native Redis (6379)', () => {
  for (const env of [serverEnv(shared), appEnv(shared)]) {
    for (const [key, value] of Object.entries(env)) {
      assert.doesNotMatch(String(value), /:(5620|5600|5601|6379)\b/, `${key}=${value}`);
      assert.doesNotMatch(String(value), /localhost/, `${key}=${value}`);
    }
  }
  assert.equal(shared.ORIGIN, 'http://127.0.0.1:5650');
  assert.equal(shared.BATSHIT_ARTIFACT_COMPLETE_URL, 'http://127.0.0.1:5650/api/artifacts/complete');
  assert.equal(shared.PUBLIC_BATSHIT_SERVER_URL, 'http://127.0.0.1:5651');
  assert.equal(shared.REDIS_URL, 'redis://127.0.0.1:5659/0');
  assert.equal(serverEnv(shared).PORT, '5651');
  assert.equal(serverEnv(shared).BATSHIT_SERVER_HOST, '127.0.0.1');
  assert.equal(appEnv(shared).PORT, '5650');
  assert.equal(appEnv(shared).HOST, '127.0.0.1');
});

test('the lane signs in with its own cookie and names itself as the Pinokio owner', () => {
  assert.equal(shared.BATSHIT_SESSION_COOKIE_NAME, LANE_SESSION_COOKIE);
  assert.notEqual(LANE_SESSION_COOKIE, 'batshit_session');
  assert.equal(shared.BATSHIT_RUNTIME_OWNER, 'pinokio');
  assert.equal(shared.BATSHIT_VOICE_RUNTIME_OWNER, `pinokio:${paths.root}`);
  // The next start stops only engines whose records carry this same owner (BL-343).
  assert.equal(laneVoiceRuntimeOwner(paths), shared.BATSHIT_VOICE_RUNTIME_OWNER);
  assert.equal(shared.BATSHIT_VOICE_RUNTIME_STATE_ROOT, paths.voiceEngines);
  assert.equal(shared.BATSHIT_UPDATE_CHECK_DISABLED, '1');
});

test('the child environment drops other lanes\' switches and lets the lane win', () => {
  const env = childEnv(
    { PATH: '/pinokio/bin', BATSHIT_CONTAINERIZED: '1', BATSHIT_RUNTIME_ENV: 'docker', CONFIG_PATH: '/x', PORT: '3000' },
    appEnv(shared)
  );
  assert.equal(env.PATH, '/pinokio/bin');
  assert.equal(env.PORT, '5650');
  for (const key of ['BATSHIT_CONTAINERIZED', 'BATSHIT_RUNTIME_ENV', 'CONFIG_PATH']) assert.equal(env[key], undefined);
});

test('secrets are generated once, round-trip through the file, and bad ones are named', () => {
  const generated = generateSecrets();
  assert.notEqual(generated.BATSHIT_TOKEN, generated.ENCRYPTION_KEY);
  assert.ok(generated.ENCRYPTION_KEY.length >= 32);
  const parsed = parseEnvText(formatSecretsFile(generated));
  assert.deepEqual(parsed, generated);
  assert.deepEqual(secretProblems(parsed), []);
  assert.deepEqual(secretProblems({ BATSHIT_TOKEN: 'short' }), [
    'BATSHIT_TOKEN is not a usable secret',
    'ENCRYPTION_KEY is missing'
  ]);
  assert.deepEqual(secretProblems({ ...generated, ENCRYPTION_KEY: 'replace-with-a-long-random-value-000000' }), [
    'ENCRYPTION_KEY is not a usable secret'
  ]);
});

test('Redis starts append-only, on loopback, with both modules loaded explicitly', () => {
  const args = redisServerArgs({
    redisDir: '/d/redis',
    moduleDir: '/r/lib',
    modules: ['rejson.so', 'redisearch.so'],
    logFile: '/d/logs/redis.log'
  });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag('--port'), '5659');
  assert.equal(flag('--bind'), '127.0.0.1');
  assert.equal(flag('--protected-mode'), 'yes');
  assert.equal(flag('--appendonly'), 'yes');
  assert.equal(flag('--appendfsync'), 'everysec');
  assert.equal(args.includes('--no-appendfsync-on-rewrite'), false);
  assert.equal(flag('--dir'), '/d/redis');
  assert.equal(flag('--daemonize'), 'no');
  // Its log goes to a file, not to Pinokio's terminal, where Start waits for one line (BL-363).
  assert.equal(flag('--logfile'), '/d/logs/redis.log');
  assert.equal(paths.redisLog, `${paths.logs}/redis.log`);
  assert.equal(paths.redisPreviousLog, `${paths.logs}/redis.previous.log`);
  const modules = args.flatMap((value, index) => (args[index - 1] === '--loadmodule' ? [value] : []));
  assert.deepEqual(modules, ['/r/lib/rejson.so', '/r/lib/redisearch.so']);
});

test('the native profile is the default on Linux; only explicit Windows-WSL opt-in selects durable saves', () => {
  const host = { platform: 'linux' };
  assert.equal(resolveLaunchProfile({ ...host, env: {} }), 'native');
  assert.equal(resolveLaunchProfile({ ...host, env: { [LANE_LAUNCH_PROFILE_ENV]: 'native' } }), 'native');
  assert.equal(resolveLaunchProfile({ ...host, env: { [LANE_LAUNCH_PROFILE_ENV]: 'windows-wsl' } }), 'windows-wsl');
});

test('unknown profiles and Windows-WSL outside Linux refuse rather than falling back', () => {
  for (const profile of ['', 'always', 'windows', 'windows-wsl ', 'WINDOWS-WSL', null, 1]) {
    assert.throws(() => resolveLaunchProfile({ env: { [LANE_LAUNCH_PROFILE_ENV]: profile }, platform: 'linux' }), /Unknown Pinokio launch profile/);
    assert.throws(() => redisServerArgs({ launchProfile: profile }), /Unknown Pinokio launch profile/);
  }
  for (const host of [
    { platform: 'darwin' },
    { platform: 'win32' },
    {}
  ]) {
    assert.throws(() => resolveLaunchProfile({ ...host, env: { [LANE_LAUNCH_PROFILE_ENV]: 'windows-wsl' } }), /requires a Linux guest/);
  }
});

test('the Windows-WSL profile changes only fsync policy and prevents background rewrite from skipping fsync', () => {
  const inputs = { redisDir: '/d/redis', moduleDir: '/r/lib', modules: ['rejson.so', 'redisearch.so'], logFile: '/d/logs/redis.log' };
  const native = redisServerArgs(inputs);
  assert.deepEqual(redisServerArgs({ ...inputs, launchProfile: 'native' }), native);
  const durable = redisServerArgs({ ...inputs, launchProfile: 'windows-wsl' });
  const expected = [...native];
  expected[expected.indexOf('--appendfsync') + 1] = 'always';
  expected.splice(expected.indexOf('--appendfsync') + 2, 0, '--no-appendfsync-on-rewrite', 'no');
  assert.deepEqual(durable, expected);
});
