const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const config = require('../config');
const logger = require('../utils/logger');

const LEGACY_BASE64_PATH = '.base64';
const AOF_REWRITE_MARKER = '.file-backed-upload-aof-rewrite.json';
const UPLOAD_TEMP_PATTERN = /^\.(.+)\.([0-9]+)\.([a-f0-9]{16})\.tmp$/;
let aofRewriteMonitorPromise = null;
const MIGRATE_UPLOAD_METADATA_SCRIPT = `
local base64_length = redis.call('JSON.STRLEN', KEYS[1], '${LEGACY_BASE64_PATH}')
if not base64_length then
  return 0
end
if tonumber(base64_length) ~= tonumber(ARGV[1]) then
  return redis.error_reply('Legacy upload changed while it was being migrated')
end
redis.call('JSON.SET', KEYS[1], '.storage', ARGV[2])
redis.call('JSON.SET', KEYS[1], '.relativePath', ARGV[3])
redis.call('JSON.SET', KEYS[1], '.filePath', ARGV[4])
redis.call('JSON.SET', KEYS[1], '.size', ARGV[5])
redis.call('JSON.SET', KEYS[1], '.sha256', ARGV[6])
local removed = redis.call('JSON.DEL', KEYS[1], '${LEGACY_BASE64_PATH}')
if removed ~= 1 then
  return redis.error_reply('Legacy upload Base64 removal failed')
end
return 1
`;

function validateUploadType(uploadType) {
  if (typeof uploadType !== 'string' || !/^[a-zA-Z0-9_]+$/.test(uploadType)) {
    throw new Error('Invalid upload type.');
  }
}

function validateStoredFilename(filename) {
  if (
    typeof filename !== 'string' ||
    !filename.trim() ||
    filename !== path.basename(filename) ||
    filename.includes('..')
  ) {
    throw new Error('Invalid upload filename.');
  }
}

function resolveStoredUploadPath(uploadType, filename, uploadRoot = config.uploadsDir) {
  validateUploadType(uploadType);
  validateStoredFilename(filename);

  const resolvedRoot = path.resolve(uploadRoot);
  const resolvedPath = path.resolve(resolvedRoot, uploadType, filename);
  if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Upload path escaped the configured upload directory.');
  }
  return resolvedPath;
}

function resolveFileBackedPayloadPath(payload, uploadRoot = config.uploadsDir) {
  const resolvedRoot = path.resolve(uploadRoot);
  const candidate =
    typeof payload?.relativePath === 'string' && payload.relativePath
      ? path.resolve(resolvedRoot, payload.relativePath)
      : typeof payload?.filePath === 'string' && payload.filePath
        ? path.resolve(payload.filePath)
        : null;

  if (!candidate) return null;
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Stored upload path escaped the configured upload directory.');
  }
  return candidate;
}

function uploadIdentityFromRecord(redisKey, payload) {
  if (typeof redisKey !== 'string' || !redisKey.startsWith('upload:')) {
    throw new Error(`Invalid upload Redis key: ${redisKey}`);
  }

  const keyParts = redisKey.split(':');
  const uploadType =
    typeof payload?.uploadType === 'string' && payload.uploadType.trim()
      ? payload.uploadType.trim()
      : keyParts[1];
  const filename =
    typeof payload?.filename === 'string' && payload.filename.trim()
      ? payload.filename.trim()
      : keyParts.at(-1);

  validateUploadType(uploadType);
  validateStoredFilename(filename);
  return { uploadType, filename };
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hashFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function verifyExistingFile(filePath, expected) {
  const actual = await hashFile(filePath);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`Upload file collision at ${filePath}; existing bytes do not match.`);
  }
}

async function syncDirectory(directoryPath) {
  const handle = await fs.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeVerifiedFileAtomically(filePath, buffer) {
  const expected = { bytes: buffer.length, sha256: hashBuffer(buffer) };
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    await verifyExistingFile(filePath, expected);
    return { ...expected, created: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  );
  let tempHandle = null;
  try {
    tempHandle = await fs.open(tempPath, 'wx', 0o600);
    await tempHandle.writeFile(buffer);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;
    await verifyExistingFile(tempPath, expected);

    try {
      await fs.link(tempPath, filePath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await verifyExistingFile(filePath, expected);
      return { ...expected, created: false };
    }

    await syncDirectory(path.dirname(filePath));

    return { ...expected, created: true };
  } finally {
    if (tempHandle) await tempHandle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function cleanupAbandonedUploadTemps(uploadRoot = config.uploadsDir) {
  const removed = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const match = entry.name.match(UPLOAD_TEMP_PATTERN);
      if (!match || processIsAlive(Number(match[2]))) continue;
      await fs.rm(entryPath);
      removed.push(entryPath);
    }
  }
  await visit(path.resolve(uploadRoot));
  return removed;
}

function buildFileBackedPayload(payload, { filePath, relativePath, size, sha256 }) {
  const next = {
    ...payload,
    storage: 'filesystem',
    relativePath,
    filePath,
    size,
    sha256
  };
  delete next.base64;
  return next;
}

async function persistFileBackedUpload({
  redisService,
  redisKey,
  uploadType,
  filename,
  buffer,
  payload,
  ttlSeconds = 0,
  uploadRoot = config.uploadsDir
}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('File-backed upload requires a Buffer.');
  const filePath = resolveStoredUploadPath(uploadType, filename, uploadRoot);
  const written = await writeVerifiedFileAtomically(filePath, buffer);
  const relativePath = path.relative(path.resolve(uploadRoot), filePath).split(path.sep).join('/');
  const storedPayload = buildFileBackedPayload(payload, {
    filePath,
    relativePath,
    size: buffer.length,
    sha256: written.sha256
  });

  try {
    const stored = await redisService.setWithTTL(redisKey, storedPayload, ttlSeconds);
    if (!stored) throw new Error('Redis rejected file-backed upload metadata.');
  } catch (error) {
    if (written.created) await fs.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }

  return storedPayload;
}

async function deleteFileBackedPayload(payload, uploadRoot = config.uploadsDir) {
  const filePath = resolveFileBackedPayloadPath(payload, uploadRoot);
  if (!filePath) return false;
  await fs.rm(filePath, { force: true });
  return true;
}

function normalizeScanBatch(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function aofRewriteMarkerPath(uploadRoot) {
  return path.join(path.resolve(uploadRoot), AOF_REWRITE_MARKER);
}

async function writeJsonDurably(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const handle = await fs.open(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function readAofRewriteMarker(uploadRoot) {
  try {
    return JSON.parse(await fs.readFile(aofRewriteMarkerPath(uploadRoot), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function markAofRewritePending({ redisService, uploadRoot }) {
  const markerPath = aofRewriteMarkerPath(uploadRoot);
  const existing = await readAofRewriteMarker(uploadRoot);
  if (existing?.migrationComplete === false) return existing;
  const [persistenceRaw, serverRaw] = await Promise.all([
    redisService.client.info('persistence'),
    redisService.client.info('server')
  ]);
  const persistence = parseRedisInfo(persistenceRaw);
  const server = parseRedisInfo(serverRaw);
  const marker = {
    createdAt: new Date().toISOString(),
    migrationComplete: false,
    redisRunId: server.run_id || null,
    baselineAofRewrites: Number(persistence.aof_rewrites || 0)
  };
  await writeJsonDurably(markerPath, marker);
  return marker;
}

async function completeAofRewriteMarker({ redisService, uploadRoot }) {
  const markerPath = aofRewriteMarkerPath(uploadRoot);
  const marker = await readAofRewriteMarker(uploadRoot);
  if (!marker || marker.migrationComplete !== false) return marker;

  const [persistenceRaw, serverRaw] = await Promise.all([
    redisService.client.info('persistence'),
    redisService.client.info('server')
  ]);
  const persistence = parseRedisInfo(persistenceRaw);
  const server = parseRedisInfo(serverRaw);
  const currentRewrites = Number(persistence.aof_rewrites || 0);
  const completedMarker = {
    ...marker,
    migrationCompletedAt: new Date().toISOString(),
    migrationComplete: true,
    redisRunId: server.run_id || marker.redisRunId || null,
    baselineAofRewrites: currentRewrites,
    requiredAofRewrites:
      currentRewrites + (persistence.aof_rewrite_in_progress === '1' ? 2 : 1)
  };
  await writeJsonDurably(markerPath, completedMarker);
  return completedMarker;
}

async function migrateLegacyBase64Uploads({
  redisService,
  uploadRoot = config.uploadsDir,
  shouldStop = () => false
}) {
  const client = redisService?.client;
  if (!client?.isOpen) {
    throw new Error('Cannot migrate legacy uploads before Redis is connected.');
  }

  const result = {
    scanned: 0,
    migrated: 0,
    skippedEphemeral: 0,
    bytesMoved: 0,
    interrupted: false
  };

  const abandonedTemps = await cleanupAbandonedUploadTemps(uploadRoot);
  if (abandonedTemps.length > 0) {
    logger.info(`[UploadMigration] Removed ${abandonedTemps.length} abandoned upload temp file(s).`);
  }

  for await (const scanValue of client.scanIterator({ MATCH: 'upload:*', COUNT: 25 })) {
    for (const redisKey of normalizeScanBatch(scanValue)) {
      if (shouldStop()) {
        result.interrupted = true;
        return result;
      }
      result.scanned += 1;
      const payload = await client.json.get(redisKey);
      if (!payload || typeof payload !== 'object' || typeof payload.base64 !== 'string') continue;

      const ttlMs = await client.pTTL(redisKey);
      const ephemeral =
        payload.ephemeralUpload === true ||
        (Number.isFinite(payload.ttlSeconds) && payload.ttlSeconds > 0) ||
        ttlMs >= 0;
      if (ephemeral) {
        result.skippedEphemeral += 1;
        continue;
      }

      const { uploadType, filename } = uploadIdentityFromRecord(redisKey, payload);
      const buffer = Buffer.from(payload.base64, 'base64');
      if (Number.isFinite(payload.size) && payload.size !== buffer.length) {
        throw new Error(
          `Legacy upload size mismatch at ${redisKey}: metadata=${payload.size}, decoded=${buffer.length}.`
        );
      }

      const filePath = resolveStoredUploadPath(uploadType, filename, uploadRoot);
      const written = await writeVerifiedFileAtomically(filePath, buffer);
      const relativePath = path.relative(path.resolve(uploadRoot), filePath).split(path.sep).join('/');

      if (shouldStop()) {
        if (written.created) await fs.rm(filePath, { force: true });
        result.interrupted = true;
        return result;
      }

      try {
        await markAofRewritePending({ redisService, uploadRoot });
        const switched = await client.eval(MIGRATE_UPLOAD_METADATA_SCRIPT, {
          keys: [redisKey],
          arguments: [
            String(payload.base64.length),
            JSON.stringify('filesystem'),
            JSON.stringify(relativePath),
            JSON.stringify(filePath),
            String(buffer.length),
            JSON.stringify(written.sha256)
          ]
        });
        if (Number(switched) !== 1) {
          await verifyExistingFile(filePath, { bytes: buffer.length, sha256: written.sha256 });
          continue;
        }
      } catch (error) {
        if (written.created) await fs.rm(filePath, { force: true }).catch(() => {});
        throw error;
      }

      result.migrated += 1;
      result.bytesMoved += buffer.length;
      logger.info(
        `[UploadMigration] Migrated ${redisKey} to ${relativePath} (${buffer.length} bytes).`
      );
    }
  }

  await completeAofRewriteMarker({ redisService, uploadRoot });
  return result;
}

function parseRedisInfo(info) {
  return Object.fromEntries(
    String(info || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes(':'))
      .map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

async function ensureAofRewriteAfterMigration({
  redisService,
  migration,
  uploadRoot = config.uploadsDir
}) {
  const client = redisService?.client;
  if (!client?.isOpen) {
    throw new Error('Cannot compact AOF after upload migration because Redis is disconnected.');
  }

  let marker = await readAofRewriteMarker(uploadRoot);
  if (!marker) return false;
  if (marker.migrationComplete === false) {
    logger.info(
      '[UploadMigration] AOF compaction remains pending until the interrupted upload migration completes.'
    );
    return false;
  }

  const [persistenceRaw, serverRaw] = await Promise.all([
    client.info('persistence'),
    client.info('server')
  ]);
  const persistence = parseRedisInfo(persistenceRaw);
  const server = parseRedisInfo(serverRaw);
  if (persistence.aof_enabled !== '1') {
    logger.info('[UploadMigration] AOF is disabled; no background AOF compaction is required.');
    await fs.rm(aofRewriteMarkerPath(uploadRoot), { force: true });
    return false;
  }
  if (server.run_id && marker.redisRunId !== server.run_id) {
    const currentRewrites = Number(persistence.aof_rewrites || 0);
    marker = {
      ...marker,
      rebasedAt: new Date().toISOString(),
      migrationComplete: true,
      redisRunId: server.run_id,
      baselineAofRewrites: currentRewrites,
      requiredAofRewrites: currentRewrites + 1
    };
    await writeJsonDurably(aofRewriteMarkerPath(uploadRoot), marker);
    logger.info('[UploadMigration] Rebased pending AOF compaction after Redis restart.');
  }
  const baseline = Number(marker.baselineAofRewrites || 0);
  const requiredRewrites = Number(marker.requiredAofRewrites || baseline + 1);
  const rewrites = Number(persistence.aof_rewrites || 0);
  if (
    persistence.aof_rewrite_in_progress === '0' &&
    rewrites >= requiredRewrites &&
    persistence.aof_last_bgrewrite_status === 'ok'
  ) {
    await fs.rm(aofRewriteMarkerPath(uploadRoot), { force: true });
    await syncDirectory(path.resolve(uploadRoot));
    logger.info('[UploadMigration] Confirmed background AOF compaction completed successfully.');
    return true;
  }

  if (persistence.aof_rewrite_in_progress !== '1') {
    await client.bgRewriteAof();
    logger.info('[UploadMigration] Started a background AOF rewrite for migrated upload bytes.');
  } else {
    logger.info('[UploadMigration] An AOF rewrite is already in progress.');
  }

  aofRewriteMonitorPromise ??= (async () => {
    while (client.isOpen) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
      });
      if (!client.isOpen) return;
      const latest = parseRedisInfo(await client.info('persistence'));
      if (latest.aof_rewrite_in_progress === '1') continue;
      const latestRewrites = Number(latest.aof_rewrites || 0);
      if (latestRewrites < requiredRewrites && latest.aof_last_bgrewrite_status === 'ok') {
        await client.bgRewriteAof();
        logger.info('[UploadMigration] Started the required post-migration AOF rewrite.');
        continue;
      }
      if (latestRewrites >= requiredRewrites && latest.aof_last_bgrewrite_status === 'ok') {
        await fs.rm(aofRewriteMarkerPath(uploadRoot), { force: true });
        await syncDirectory(path.resolve(uploadRoot));
        logger.info('[UploadMigration] Background AOF compaction completed successfully.');
      } else {
        logger.error(
          '[UploadMigration] Background AOF compaction failed; the durable retry marker remains.'
        );
      }
      return;
    }
  })()
    .catch((error) => {
      logger.error(
        '[UploadMigration] AOF compaction monitoring failed; the durable retry marker remains.',
        error
      );
    })
    .finally(() => {
      aofRewriteMonitorPromise = null;
    });
  return true;
}

module.exports = {
  MIGRATE_UPLOAD_METADATA_SCRIPT,
  buildFileBackedPayload,
  deleteFileBackedPayload,
  cleanupAbandonedUploadTemps,
  ensureAofRewriteAfterMigration,
  migrateLegacyBase64Uploads,
  persistFileBackedUpload,
  resolveFileBackedPayloadPath,
  resolveStoredUploadPath,
  uploadIdentityFromRecord,
  writeVerifiedFileAtomically
};
