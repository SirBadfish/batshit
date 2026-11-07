const fs = require('node:fs/promises');
const path = require('node:path');
const {
  resolveFileBackedPayloadPath,
  resolveStoredUploadPath
} = require('./fileBackedUploadService');

/**
 * Owner sweep for avatar uploads (BL-41, 2026-09-22; Subagents, Groups, and the keep list
 * BL-139, BL-140, BL-142, 2026-09-25).
 *
 * `POST /api/upload/avatar` stores one picture per upload and names it after its owner:
 * `<entityType>_<entityId>_<Date.now()>.jpg`, recorded under
 * `upload:avatars:<entityType>:<file>` with the bytes at `<uploadsDir>/avatars/<file>`.
 * Uploads do not delete replaced pictures; saved-owner tidy and owner deletion clean them
 * up under the rules below. Leaving an edit unsaved can leave pictures behind. Before
 * 2025-08-12 the route wrote
 * `avatar_<Date.now()>.jpg` under the flat key `upload:avatars:<file>`; that name says
 * nothing about its owner, so only the owner's record, which still points at it, can.
 *
 * Deleting the owner sweeps all of it:
 * - every record whose filename is EXACTLY this owner's shape, under both key forms (the
 *   serve route reads `upload:avatars:<file>` first), and the file each record points at;
 * - every file in `avatars/` with this owner's exact name that no record points at any more;
 * - the legacy flat pictures the caller names, record and file, or the file alone when its
 *   record is already gone (the app sends only ones the owner's record points at and
 *   nothing else references).
 *
 * The match is exact because ids contain underscores: a bare prefix `agent_n8n_agent_`
 * would also take `agent_n8n_agent_ctrlain_<ts>.jpg`, a different agent's picture.
 *
 * A living owner is tidied the same way (`tidy: true`, BL-142): its settings save the
 * record first, then ask for every picture of that owner except the one the saved record
 * shows (`keepFilenames`). That is also why no picture is deleted at upload time any more
 * (BL-145; the user and Group panels too since BL-281): a refused save kept pointing at a
 * picture the upload had deleted. A user is tidied but never deleted through here.
 *
 * Ordinary tidy candidates must pass BOTH chronology and the ten-minute grace (BL-288/634):
 * before the newest kept picture, or with none kept no newer than the named replacement,
 * or with neither only the age cutoff. Only the exact replaced filename may bypass those
 * cutoffs; the owner's kept pictures always stay. An
 * upload and a sweep of one owner take turns (`avatarOwnerLock.js`), so an upload is either
 * wholly before the sweep's reads or wholly after them, and its name is later than any
 * picture the owner had.
 */

const AVATAR_UPLOAD_TYPE = 'avatars';
// The owners whose delete sweeps its pictures. A user is never deleted through here.
const AVATAR_OWNER_DELETE_TYPES = new Set(['agent', 'subagent', 'group']);
// Every owner a picture can be uploaded for (BL-143), and so every owner a settings save can
// tidy (the user since BL-281). The upload names the picture after it.
const AVATAR_UPLOAD_OWNER_TYPES = new Set(['user', ...AVATAR_OWNER_DELETE_TYPES]);
// BL-288/634: every ordinary tidy candidate gets this grace, even with a newer kept picture.
// Only the exact replaced filename can bypass it; keep always wins. Expired pictures still
// require chronological eligibility at a later tidy; owner deletion retains its own rule.
const TIDY_RECENT_UPLOAD_GRACE_MS = 10 * 60 * 1000;
// The rule `redis.deleteAgent` already enforces (its memory-media sweep refuses anything
// else), with no length cap on purpose: a stricter rule here would make a deletable agent
// undeletable. No trimming either: agent ids are trimmed when the agent is created, and a
// trimmed " bob " would sweep the pictures of a different agent, "bob". The rule is also what
// makes the owner id safe to place unescaped in a Redis MATCH pattern and in a RegExp: none
// of these characters is a glob or regex metacharacter.
const AVATAR_OWNER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
// The only name the upload route wrote without an owner.
const LEGACY_FLAT_AVATAR_FILENAME = /^avatar_[0-9]{1,20}\.jpg$/;
const MAX_LEGACY_AVATAR_FILENAMES = 8;
// A record shows at most two pictures (`avatar` and `avatar_url`); a little room to spare.
const MAX_KEEP_AVATAR_FILENAMES = 4;
const SCAN_COUNT = 500;

class AvatarOwnerDeleteRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AvatarOwnerDeleteRequestError';
    this.statusCode = 400;
  }
}

function parseAvatarOwnerDeleteRequest(body) {
  if (body?.tidy !== undefined && typeof body.tidy !== 'boolean') {
    throw new AvatarOwnerDeleteRequestError('tidy must be true or false.');
  }
  const tidy = body?.tidy === true;
  const entityType = typeof body?.entityType === 'string' ? body.entityType : '';
  if (tidy && !AVATAR_UPLOAD_OWNER_TYPES.has(entityType)) {
    throw new AvatarOwnerDeleteRequestError('entityType must be "user", "agent", "subagent", or "group".');
  }
  if (!tidy && !AVATAR_OWNER_DELETE_TYPES.has(entityType)) {
    throw new AvatarOwnerDeleteRequestError('entityType must be "agent", "subagent", or "group".');
  }
  const entityId = typeof body?.entityId === 'string' ? body.entityId : '';
  if (!AVATAR_OWNER_ID_PATTERN.test(entityId)) {
    throw new AvatarOwnerDeleteRequestError(
      'entityId must be letters, digits, "_" or "-" (the owner id rule every avatar upload meets).'
    );
  }
  const rawLegacy = body?.legacyFilenames ?? [];
  if (!Array.isArray(rawLegacy) || rawLegacy.length > MAX_LEGACY_AVATAR_FILENAMES) {
    throw new AvatarOwnerDeleteRequestError(
      `legacyFilenames must be a list of at most ${MAX_LEGACY_AVATAR_FILENAMES} names.`
    );
  }
  for (const filename of rawLegacy) {
    if (typeof filename !== 'string' || !LEGACY_FLAT_AVATAR_FILENAME.test(filename)) {
      throw new AvatarOwnerDeleteRequestError(
        'legacyFilenames may only name pre-2025-08-12 pictures (avatar_<timestamp>.jpg).'
      );
    }
  }
  if (tidy && rawLegacy.length > 0) {
    throw new AvatarOwnerDeleteRequestError('A tidy names no legacy pictures: they go only with their owner.');
  }
  const rawKeep = body?.keepFilenames ?? [];
  if (!tidy && Array.isArray(rawKeep) && rawKeep.length > 0) {
    throw new AvatarOwnerDeleteRequestError('keepFilenames is only for a tidy (tidy: true).');
  }
  if (!Array.isArray(rawKeep) || rawKeep.length > MAX_KEEP_AVATAR_FILENAMES) {
    throw new AvatarOwnerDeleteRequestError(
      `keepFilenames must be a list of at most ${MAX_KEEP_AVATAR_FILENAMES} names.`
    );
  }
  const owned = ownedAvatarFilenamePattern(entityType, entityId);
  for (const filename of rawKeep) {
    if (typeof filename !== 'string' || !owned.test(filename)) {
      throw new AvatarOwnerDeleteRequestError(
        `keepFilenames may only name this ${entityType}'s own pictures (${entityType}_${entityId}_<timestamp>.jpg).`
      );
    }
  }
  const rawReplaced = body?.replacedFilename ?? null;
  if (rawReplaced !== null && (!tidy || typeof rawReplaced !== 'string' || !owned.test(rawReplaced))) {
    throw new AvatarOwnerDeleteRequestError(
      `replacedFilename may only name, in a tidy, this ${entityType}'s own picture the save replaced (${entityType}_${entityId}_<timestamp>.jpg).`
    );
  }
  return {
    tidy,
    entityType,
    entityId,
    legacyFilenames: [...new Set(rawLegacy)],
    keepFilenames: [...new Set(rawKeep)],
    replacedFilename: rawReplaced
  };
}

/**
 * The owner of an avatar upload (BL-143, 2026-09-25). Every picture is named after its owner,
 * which is the only way a later delete or tidy can find it, so an upload with no owner, an
 * unknown owner type, or an owner id outside the owner id rule is refused. Before, a missing
 * `entityId` wrote an ownerless `avatar_<ts>.jpg` that no owner sweep can ever reach.
 */
function parseAvatarUploadOwner(body) {
  const entityType = typeof body?.entityType === 'string' ? body.entityType : '';
  if (!AVATAR_UPLOAD_OWNER_TYPES.has(entityType)) {
    throw new AvatarOwnerDeleteRequestError('entityType must be "user", "agent", "subagent", or "group".');
  }
  const entityId = typeof body?.entityId === 'string' ? body.entityId : '';
  if (!AVATAR_OWNER_ID_PATTERN.test(entityId)) {
    throw new AvatarOwnerDeleteRequestError(
      'entityId must be letters, digits, "_" or "-" (the owner id rule every avatar upload meets).'
    );
  }
  return { entityType, entityId };
}

/** Whether `filename` is one of this owner's own pictures (`<type>_<id>_<digits>.jpg`, exactly). */
function isOwnedAvatarFilename(entityType, entityId, filename) {
  return typeof filename === 'string' && ownedAvatarFilenamePattern(entityType, entityId).test(filename);
}

function ownedAvatarFilenamePattern(entityType, entityId) {
  // Anchored at both ends. The timestamp has no "_", so the id between "<type>_" and the
  // last "_" is exactly this owner's.
  return new RegExp(`^${entityType}_${entityId}_[0-9]+\\.jpg$`);
}

/** The upload time an owned picture's name carries (`<type>_<id>_<Date.now()>.jpg`). */
function avatarFilenameTimestamp(filename) {
  const match = /_([0-9]+)\.jpg$/.exec(filename);
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * BL-288/634: ordinary tidy candidates must be older than BOTH the existing chronological
 * cutoff and the ten-minute grace. An earlier upload may still be unsaved in another tab.
 * With saved pictures, preserve anything newer than the newest kept one; without them,
 * preserve anything newer than the replaced one. Only the exact replaced filename may
 * bypass those cutoffs, in mayGo below, and keep/owner guards still apply to it.
 * An owner delete (no tidy) keeps its existing eligibility.
 */
function tidyDeletionCutoff({ tidy, keepFilenames, replacedFilename, nowMs }) {
  if (!tidy) return Number.POSITIVE_INFINITY;
  const graceCutoff = Number.isFinite(nowMs) ? nowMs - TIDY_RECENT_UPLOAD_GRACE_MS : Number.NaN;
  const kept = keepFilenames.map(avatarFilenameTimestamp).filter(Number.isFinite);
  if (kept.length > 0) return Math.min(Math.max(...kept), graceCutoff);
  const replaced = replacedFilename ? avatarFilenameTimestamp(replacedFilename) : Number.NaN;
  return Number.isFinite(replaced) ? Math.min(replaced + 1, graceCutoff) : graceCutoff;
}

async function scanKeys(client, match) {
  const keys = [];
  for await (const batch of client.scanIterator({ MATCH: match, COUNT: SCAN_COUNT })) {
    // node-redis 5 yields one array per SCAN reply; older clients yielded single keys.
    for (const key of Array.isArray(batch) ? batch : [batch]) keys.push(key);
  }
  return keys;
}

async function removeFileIfPresent(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function uploadRelativePath(uploadRoot, filePath) {
  return path.relative(path.resolve(uploadRoot), filePath).split(path.sep).join('/');
}

/**
 * Sweep one owner's avatar pictures. Uses the raw client on purpose: `redisService.keys()`
 * and `redisService.get()` answer "nothing" when Redis fails, which here would read as
 * "this agent has no pictures" and let the agent be deleted with its pictures still stored.
 * Every failure throws, so the caller keeps the agent and a retry picks up where this left.
 *
 * Two passes. The first reads and checks EVERY record and deletes nothing: a record that
 * cannot be read, or that points at a file other than its own name, stops the sweep with
 * nothing deleted and is named so it can be repaired by hand (checking as it went, a sweep
 * would delete some pictures first and then hit the same record on every retry). The second
 * deletes, per record the file first and the key second, so a failure in between leaves the
 * record for the retry to find again.
 */
async function sweepOwnedAvatars({
  client,
  uploadRoot,
  entityType,
  entityId,
  legacyFilenames = [],
  keepFilenames = [],
  replacedFilename = null,
  tidy = false,
  nowMs = Date.now()
}) {
  const owned = ownedAvatarFilenamePattern(entityType, entityId);
  const legacy = new Set(legacyFilenames);
  // Pictures the owner still shows (a tidy): never read, checked, or deleted, under either key form.
  const keep = new Set(keepFilenames);
  // BL-288: and a tidy leaves every picture that may still be on its way to a save.
  const cutoff = tidyDeletionCutoff({ tidy, keepFilenames, replacedFilename, nowMs });
  const mayGo = (filename) =>
    owned.test(filename) && !keep.has(filename) &&
    ((tidy && filename === replacedFilename) || avatarFilenameTimestamp(filename) < cutoff);
  const candidates = new Map();
  for (const prefix of [`upload:${AVATAR_UPLOAD_TYPE}:${entityType}:`, `upload:${AVATAR_UPLOAD_TYPE}:`]) {
    for (const key of await scanKeys(client, `${prefix}${entityType}_${entityId}_*`)) {
      const filename = key.slice(prefix.length);
      if (mayGo(filename)) candidates.set(key, filename);
    }
  }
  for (const filename of legacyFilenames) {
    candidates.set(`upload:${AVATAR_UPLOAD_TYPE}:${filename}`, filename);
    candidates.set(`upload:${AVATAR_UPLOAD_TYPE}:${entityType}:${filename}`, filename);
  }

  // Pass 1: check every record; delete nothing.
  const records = [];
  const problems = [];
  for (const [key, filename] of candidates) {
    let payload;
    try {
      payload = await client.json.get(key);
    } catch (error) {
      throw new Error(`Nothing was deleted: avatar record ${key} could not be read (${error.message}).`);
    }
    if (payload === null || payload === undefined) continue;
    const ownFile = resolveStoredUploadPath(AVATAR_UPLOAD_TYPE, filename, uploadRoot);
    let recordedFile = null;
    try {
      recordedFile =
        payload && typeof payload === 'object' ? resolveFileBackedPayloadPath(payload, uploadRoot) : null;
    } catch (error) {
      problems.push(`${key}: ${error.message.replace(/\.$/, '')}`);
      continue;
    }
    if (recordedFile && recordedFile !== ownFile) {
      problems.push(
        `${key} points at ${uploadRelativePath(uploadRoot, recordedFile)}, not at its own file ${AVATAR_UPLOAD_TYPE}/${filename}`
      );
      continue;
    }
    records.push({ key, filename, ownFile });
  }
  if (problems.length > 0) {
    throw new Error(
      `Nothing was deleted: ${problems.length === 1 ? 'this avatar record needs' : 'these avatar records need'} repair by hand first: ${problems.join('; ')}.`
    );
  }

  // Pass 2: delete.
  const deletedRecords = [];
  const deletedFiles = new Set();
  for (const { key, filename, ownFile } of records) {
    if (await removeFileIfPresent(ownFile)) deletedFiles.add(`${AVATAR_UPLOAD_TYPE}/${filename}`);
    await client.del(key);
    deletedRecords.push(key);
  }

  // Files no record points at any more: the owner's exact name, or a legacy name the caller
  // named (its record may already be gone, and its file would otherwise stay forever).
  const avatarDir = path.join(path.resolve(uploadRoot), AVATAR_UPLOAD_TYPE);
  let entries = [];
  try {
    entries = await fs.readdir(avatarDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    // A symlink is never followed or removed: only a regular file with one of those names.
    if (!entry.isFile() || !(mayGo(entry.name) || legacy.has(entry.name))) continue;
    if (await removeFileIfPresent(path.join(avatarDir, entry.name))) {
      deletedFiles.add(`${AVATAR_UPLOAD_TYPE}/${entry.name}`);
    }
  }

  return { deletedRecords: deletedRecords.sort(), deletedFiles: [...deletedFiles].sort() };
}

module.exports = {
  AVATAR_OWNER_DELETE_TYPES,
  AVATAR_UPLOAD_OWNER_TYPES,
  TIDY_RECENT_UPLOAD_GRACE_MS,
  AvatarOwnerDeleteRequestError,
  isOwnedAvatarFilename,
  parseAvatarOwnerDeleteRequest,
  parseAvatarUploadOwner,
  sweepOwnedAvatars
};
