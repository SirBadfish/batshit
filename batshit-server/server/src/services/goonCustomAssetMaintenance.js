const { createSerialTransactionQueue } = require('./serialTransactionQueue');

const RESTORE_KEY = 'goon_asset_restore';
const DONE_KEY_PREFIX = 'goon_asset_restore_done:';
const DRAIN_TIMEOUT_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BEGIN_SCRIPT = `
-- BEGIN_GOON_ASSET_RESTORE
if redis.call('EXISTS', KEYS[2]) ~= 0 then
  return redis.call('EXISTS', KEYS[1]) == 0 and 'CLOSED_IDLE' or 'CLOSED_ACTIVE'
end
local current = redis.call('GET', KEYS[1])
if current then
  if current == ARGV[1] then return 'EXISTING' end
  return 'CONFLICT'
end
redis.call('SET', KEYS[1], ARGV[1])
return 'CREATED'
`;

const END_SCRIPT = `
-- END_GOON_ASSET_RESTORE
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then return 'CONFLICT' end
if current then redis.call('DEL', KEYS[1]) end
redis.call('SET', KEYS[2], ARGV[1])
return current and 'RELEASED' or 'ABSENT'
`;

function maintenanceError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateToken(token) {
  if (typeof token !== 'string' || !UUID_PATTERN.test(token)) {
    throw maintenanceError('A UUID restore maintenance token is required.', 400);
  }
}

/** One file-service process owns one upload root. Redis fences process restarts;
 * the local count includes operations entered before begin, including multipart
 * parsing and rollback after a disconnected HTTP peer. */
function createGoonCustomAssetMaintenance(getClient, { drainTimeoutMs = DRAIN_TIMEOUT_MS } = {}) {
  const queue = createSerialTransactionQueue();
  const zeroWaiters = new Set();
  let blocked = false;
  let active = 0;
  let blockEpoch = 0;

  function releaseActive() {
    active -= 1;
    if (active !== 0) return;
    for (const resolve of zeroWaiters) resolve();
    zeroWaiters.clear();
  }

  function waitForDrain() {
    if (active === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        zeroWaiters.delete(finish);
        resolve();
      };
      zeroWaiters.add(finish);
      timer = setTimeout(() => {
        zeroWaiters.delete(finish);
        reject(maintenanceError('Custom Goon asset operations did not drain within 30 seconds.', 503));
      }, drainTimeoutMs);
    });
  }

  async function enter() {
    // This increment happens before the first await. A concurrent begin cannot
    // miss an operation that has passed the local barrier.
    active += 1;
    try {
      if (blocked) throw maintenanceError('Custom Goon assets are paused for restore.', 409);
      const marker = await getClient().get(RESTORE_KEY);
      if (marker !== null || blocked) {
        throw maintenanceError('Custom Goon assets are paused for restore.', 409);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseActive();
      };
    } catch (error) {
      releaseActive();
      throw error;
    }
  }

  function begin(token) {
    validateToken(token);
    // Set synchronously before queueing Redis IO or waiting for older work.
    blocked = true;
    const ownEpoch = ++blockEpoch;
    return queue.run(async () => {
      const state = await getClient().eval(BEGIN_SCRIPT, {
        keys: [RESTORE_KEY, `${DONE_KEY_PREFIX}${token}`], arguments: [token]
      });
      if (state === 'CLOSED_IDLE') {
        // A delayed duplicate begin must not strand this process after its
        // completed restore. A later queued begin still owns the local block.
        if (blockEpoch === ownEpoch) blocked = false;
        throw maintenanceError('This restore maintenance token has already been closed.', 409);
      }
      if (state === 'CLOSED_ACTIVE') {
        throw maintenanceError('This restore maintenance token is closed; another restore is active.', 409);
      }
      if (state === 'CONFLICT') throw maintenanceError('A different restore owns custom Goon asset maintenance.', 409);
      if (state !== 'CREATED' && state !== 'EXISTING') {
        throw maintenanceError(`Restore maintenance begin returned ${state}.`, 500);
      }
      await waitForDrain();
      return { token, state: state.toLowerCase(), activeOperations: 0 };
    });
  }

  function end(token) {
    validateToken(token);
    blocked = true;
    const ownEpoch = ++blockEpoch;
    return queue.run(async () => {
      // A timed-out begin may still have an old multipart upload or rollback.
      // End may release the barrier only after that whole operation settles.
      await waitForDrain();
      const state = await getClient().eval(END_SCRIPT, {
        keys: [RESTORE_KEY, `${DONE_KEY_PREFIX}${token}`], arguments: [token]
      });
      if (state === 'CONFLICT') throw maintenanceError('A different restore owns custom Goon asset maintenance.', 409);
      if (state !== 'RELEASED' && state !== 'ABSENT') {
        throw maintenanceError(`Restore maintenance end returned ${state}.`, 500);
      }
      if (blockEpoch === ownEpoch) blocked = false;
      return { token, state: state.toLowerCase() };
    });
  }

  return { enter, begin, end, get activeOperations() { return active; } };
}

module.exports = { RESTORE_KEY, createGoonCustomAssetMaintenance };
