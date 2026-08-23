const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('crypto');
const { createWriteStream } = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const config = require('../config');

const TICKET_TTL_MS = 10 * 60 * 1000;
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;
const tickets = new Map();

function tokenEquals(actual, expected) {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function assertStageId(stageId) {
  if (!/^[0-9a-f-]{36}$/i.test(stageId)) {
    const error = new Error('Invalid backup stage id');
    error.status = 400;
    throw error;
  }
}

function stagePaths(stageId) {
  assertStageId(stageId);
  const root = path.resolve(config.backupStagingDir);
  return {
    root,
    archivePath: path.join(root, `${stageId}.zip`),
    partialPath: path.join(root, `${stageId}.part`),
    metadataPath: path.join(root, `${stageId}.json`),
  };
}

async function writeJsonAtomic(targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, targetPath);
}

function createStageTicket({ userId, filename, expectedBytes }) {
  if (typeof userId !== 'string' || !userId.trim()) {
    const error = new Error('A backup stage requires a user id');
    error.status = 400;
    throw error;
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    const error = new Error('Backup size must be a positive safe integer');
    error.status = 400;
    throw error;
  }

  const stageId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  tickets.set(stageId, {
    token,
    userId: userId.trim(),
    filename: typeof filename === 'string' && filename.trim() ? filename.trim().slice(0, 255) : 'batshit-backup.zip',
    expectedBytes,
    expiresAtMs: Date.now() + TICKET_TTL_MS,
  });

  return {
    stageId,
    ticket: token,
    expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
  };
}

function consumeTicket(stageId, suppliedToken) {
  const ticket = tickets.get(stageId);
  tickets.delete(stageId);
  if (!ticket || ticket.expiresAtMs <= Date.now() || !tokenEquals(suppliedToken, ticket.token)) {
    const error = new Error('Backup upload ticket is invalid or expired');
    error.status = 401;
    throw error;
  }
  return ticket;
}

async function stageUpload({ stageId, suppliedToken, input }) {
  const ticket = consumeTicket(stageId, suppliedToken);
  const paths = stagePaths(stageId);
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.rm(paths.archivePath, { force: true }),
    fs.rm(paths.partialPath, { force: true }),
    fs.rm(paths.metadataPath, { force: true }),
  ]);

  const hash = createHash('sha256');
  let receivedBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > ticket.expectedBytes) {
        callback(new Error('Backup upload exceeded its declared size'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(input, counter, createWriteStream(paths.partialPath, { flags: 'wx', mode: 0o600 }));
    if (receivedBytes !== ticket.expectedBytes) {
      throw new Error(`Backup upload received ${receivedBytes} bytes; expected ${ticket.expectedBytes}`);
    }
    const stagedFile = await fs.open(paths.partialPath, 'r');
    try {
      await stagedFile.sync();
    } finally {
      await stagedFile.close();
    }
    await fs.rename(paths.partialPath, paths.archivePath);
    await fs.chmod(paths.archivePath, 0o400);
    const stagedAt = new Date().toISOString();
    const metadata = {
      contract: 'batshit-backup-stage/v1',
      stageId,
      userId: ticket.userId,
      filename: ticket.filename,
      bytes: receivedBytes,
      sha256: hash.digest('hex'),
      stagedAt,
      expiresAt: new Date(Date.now() + STAGE_TTL_MS).toISOString(),
      archivePath: paths.archivePath,
    };
    await writeJsonAtomic(paths.metadataPath, metadata);
    return metadata;
  } catch (error) {
    await Promise.all([
      fs.rm(paths.partialPath, { force: true }).catch(() => undefined),
      fs.rm(paths.archivePath, { force: true }).catch(() => undefined),
      fs.rm(paths.metadataPath, { force: true }).catch(() => undefined),
    ]);
    throw error;
  }
}

async function removeStage(stageId) {
  tickets.delete(stageId);
  const paths = stagePaths(stageId);
  await Promise.all([
    fs.rm(paths.archivePath, { force: true }),
    fs.rm(paths.partialPath, { force: true }),
    fs.rm(paths.metadataPath, { force: true }),
  ]);
}

async function cleanupExpiredStages(nowMs = Date.now()) {
  for (const [stageId, ticket] of tickets) {
    if (ticket.expiresAtMs <= nowMs) tickets.delete(stageId);
  }
  await fs.mkdir(config.backupStagingDir, { recursive: true, mode: 0o700 });
  const names = await fs.readdir(config.backupStagingDir).catch(() => []);
  for (const name of names) {
    if (!name.endsWith('.json')) {
      if (!name.endsWith('.part') && !name.endsWith('.zip')) continue;
      const targetPath = path.join(config.backupStagingDir, name);
      const stat = await fs.stat(targetPath).catch(() => null);
      const ttl = name.endsWith('.part') ? TICKET_TTL_MS : STAGE_TTL_MS;
      if (stat && stat.mtimeMs + ttl <= nowMs) await fs.rm(targetPath, { force: true });
      continue;
    }
    const metadataPath = path.join(config.backupStagingDir, name);
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      if (Date.parse(metadata.expiresAt) > nowMs) continue;
      await removeStage(metadata.stageId);
    } catch {
      const stat = await fs.stat(metadataPath).catch(() => null);
      if (stat && stat.mtimeMs + STAGE_TTL_MS <= nowMs) {
        await fs.rm(metadataPath, { force: true });
      }
    }
  }
}

module.exports = {
  cleanupExpiredStages,
  createStageTicket,
  removeStage,
  stageUpload,
};
