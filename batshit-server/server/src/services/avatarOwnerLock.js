/**
 * BL-288 (2026-09-27): an avatar upload and a sweep (an owner's delete, or a tidy after a
 * settings save) of the same owner take turns.
 *
 * A tidy keeps the pictures the owner's SAVED record shows and deletes the owner's others.
 * An upload that landed while a tidy ran (another tab, or ms timing) is in no saved record
 * yet, and the tidy deleted it; the form's next save then pointed at a deleted picture. With
 * this lock an upload's name and store happen either wholly before a sweep reads anything or
 * wholly after it is done, and `sweepOwnedAvatars` keeps every picture newer than the one the
 * saved record shows. The lock is in-process: one batshit-server serves one instance's uploads.
 *
 * The same turn hands out the picture's timestamp: strictly later than the owner's previous
 * one, so two uploads in one millisecond never share a name (the second overwrote the first),
 * and "uploaded after the kept picture" is exact.
 */

const tails = new Map();
const lastTimestamps = new Map();

function ownerKey(entityType, entityId) {
  return `${entityType}:${entityId}`;
}

/** Run `work` once every earlier upload or sweep of this owner is done; the next waits for it. */
async function withAvatarOwnerLock(entityType, entityId, work) {
  const key = ownerKey(entityType, entityId);
  const previous = tails.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  tails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** The next picture timestamp for this owner. Call it inside `withAvatarOwnerLock`. */
function nextAvatarTimestamp(entityType, entityId, now = Date.now()) {
  const key = ownerKey(entityType, entityId);
  const timestamp = Math.max(now, (lastTimestamps.get(key) ?? 0) + 1);
  lastTimestamps.set(key, timestamp);
  return timestamp;
}

module.exports = {
  nextAvatarTimestamp,
  withAvatarOwnerLock
};
