const { randomUUID } = require('crypto');

const CONTRACT = 'goon-asset-deletion/v1';
const CUSTOM_UPLOAD_TYPES = new Set([
  'goon_custom_packages',
  'goon_custom_models',
  'goon_custom_manifests',
  'goon_hair_assets',
  'goon_hair_imports'
]);

function isCustomRecipeAsset(uploadType) {
  return CUSTOM_UPLOAD_TYPES.has(uploadType);
}

function claimKey(uploadType, filename) {
  return `goon_asset_delete:${uploadType}:${filename}`;
}

// The publication queue owns the only file-service writer in one Batshit instance.
// A publishing marker left by its previous process may be adopted, but a reserved
// or deleting marker belongs to the app's guarded reference cleanup.
const CLAIM_PUBLICATION = `
-- CLAIM_PUBLICATION
for index = 1, #KEYS do
  local raw = redis.call('GET', KEYS[index])
  if raw then
    local ok, marker = pcall(cjson.decode, raw)
    if not ok or type(marker) ~= 'table' or marker['contract'] ~= ARGV[1] or
       type(marker['token']) ~= 'string' or marker['token'] == '' or
       (marker['phase'] ~= 'publishing' and marker['phase'] ~= 'reserved' and marker['phase'] ~= 'deleting') then
      return 'INVALID_MARKER'
    end
    if marker['phase'] ~= 'publishing' then return 'BLOCKED' end
  end
end
for index = 1, #KEYS do
  redis.call('SET', KEYS[index], ARGV[2])
end
return 'CLAIMED'
`;

const RELEASE_PUBLICATION = `
-- RELEASE_PUBLICATION
for index = 1, #KEYS do
  local raw = redis.call('GET', KEYS[index])
  if not raw then return 'MISSING_MARKER' end
  local ok, marker = pcall(cjson.decode, raw)
  if not ok or type(marker) ~= 'table' or marker['contract'] ~= ARGV[1] or
     marker['token'] ~= ARGV[2] or marker['phase'] ~= 'publishing' then
    return 'CHANGED_MARKER'
  end
end
for index = 1, #KEYS do redis.call('DEL', KEYS[index]) end
return 'RELEASED'
`;

const RESERVE_DELETION = `
-- RESERVE_DELETION
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, marker = pcall(cjson.decode, raw)
  if not ok or type(marker) ~= 'table' or marker['contract'] ~= ARGV[1] or
     type(marker['token']) ~= 'string' or marker['token'] == '' or
     (marker['phase'] ~= 'publishing' and marker['phase'] ~= 'reserved' and marker['phase'] ~= 'deleting') then
    return 'INVALID_MARKER'
  end
  if marker['phase'] ~= 'publishing' then
    return 'EXISTING:' .. raw
  end
end
redis.call('SET', KEYS[1], ARGV[2])
return raw and 'RECOVERED:' .. ARGV[2] or 'CREATED:' .. ARGV[2]
`;

const BEGIN_DELETION = `
-- BEGIN_DELETION
if ARGV[3] ~= '' then
  local context = cjson.decode(ARGV[3])
  local jobRaw = redis.call('JSON.GET', context.jobKey)
  if not jobRaw then return 'CHANGED_JOB' end
  if context.expectedRaw then
    if jobRaw ~= context.expectedRaw then return 'CHANGED_JOB' end
  else
    local job = cjson.decode(jobRaw)
    if job.stateVersion ~= context.stateVersion then return 'CHANGED_JOB' end
  end
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'MISSING_MARKER' end
local ok, marker = pcall(cjson.decode, raw)
if not ok or type(marker) ~= 'table' or marker['contract'] ~= ARGV[1] or
   type(marker['token']) ~= 'string' or marker['token'] == '' or
   (marker['phase'] ~= 'reserved' and marker['phase'] ~= 'deleting') then
  return 'INVALID_MARKER'
end
if marker['token'] ~= ARGV[2] then return 'WRONG_TOKEN' end
if marker['phase'] == 'reserved' then
  marker['phase'] = 'deleting'
  redis.call('SET', KEYS[1], cjson.encode(marker))
end
return 'DELETING'
`;

const FINISH_DELETION = `
-- FINISH_DELETION
local raw = redis.call('GET', KEYS[1])
if not raw then return 'MISSING_MARKER' end
local ok, marker = pcall(cjson.decode, raw)
if not ok or type(marker) ~= 'table' or marker['contract'] ~= ARGV[1] or
   marker['token'] ~= ARGV[2] or marker['phase'] ~= 'deleting' then
  return 'CHANGED_MARKER'
end
redis.call('DEL', KEYS[1])
return 'RELEASED'
`;

function protocolError(result, action) {
  const error = new Error(`Custom Goon asset ${action} was refused (${result}).`);
  error.statusCode = result === 'BLOCKED' || result === 'WRONG_TOKEN' ||
    result === 'MISSING_MARKER' || result === 'CHANGED_MARKER' || result === 'CHANGED_JOB' ? 409 : 500;
  return error;
}

async function claimCustomRecipePublication(client, assets) {
  const keys = [...new Set(assets.map(({ uploadType, filename }) => claimKey(uploadType, filename)))].sort();
  const token = randomUUID();
  const marker = JSON.stringify({ contract: CONTRACT, token, phase: 'publishing' });
  const result = await client.eval(CLAIM_PUBLICATION, {
    keys, arguments: [CONTRACT, marker]
  });
  if (result !== 'CLAIMED') throw protocolError(result, 'publication');
  return { keys, token };
}

async function releaseCustomRecipePublication(client, claim) {
  const result = await client.eval(RELEASE_PUBLICATION, {
    keys: claim.keys, arguments: [CONTRACT, claim.token]
  });
  if (result !== 'RELEASED') throw protocolError(result, 'publication release');
}

async function reserveCustomRecipeDeletion(client, uploadType, filename) {
  const token = randomUUID();
  const requested = JSON.stringify({ contract: CONTRACT, token, phase: 'reserved' });
  const result = await client.eval(RESERVE_DELETION, {
    keys: [claimKey(uploadType, filename)], arguments: [CONTRACT, requested]
  });
  const separator = typeof result === 'string' ? result.indexOf(':') : -1;
  if (separator < 0) throw protocolError(result, 'deletion reservation');
  const state = result.slice(0, separator);
  if (!['CREATED', 'RECOVERED', 'EXISTING'].includes(state)) {
    throw protocolError(state, 'deletion reservation');
  }
  let reservation;
  try {
    reservation = JSON.parse(result.slice(separator + 1));
  } catch {
    throw protocolError('INVALID_MARKER', 'deletion reservation');
  }
  if (reservation.contract !== CONTRACT || typeof reservation.token !== 'string' ||
      !['reserved', 'deleting'].includes(reservation.phase)) {
    throw protocolError('INVALID_MARKER', 'deletion reservation');
  }
  return { reservation, state: state.toLowerCase() };
}

async function beginCustomRecipeDeletion(client, uploadType, filename, token, cleanupContext) {
  if (typeof token !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    throw Object.assign(protocolError('INVALID_TOKEN', 'deletion'), { deletionNotStarted: true });
  }
  const result = await client.eval(BEGIN_DELETION, {
    keys: [claimKey(uploadType, filename)], arguments: [CONTRACT, token, cleanupContext ? JSON.stringify(cleanupContext) : '']
  });
  if (result !== 'DELETING') {
    const error = protocolError(result, 'deletion');
    // These actual Lua returns precede every marker write. A thrown/unknown
    // Redis response proves nothing; its token must remain for recovery.
    if (['CHANGED_JOB', 'MISSING_MARKER', 'INVALID_MARKER', 'WRONG_TOKEN'].includes(result)) error.deletionNotStarted = true;
    throw error;
  }
}

async function finishCustomRecipeDeletion(client, uploadType, filename, token) {
  const result = await client.eval(FINISH_DELETION, {
    keys: [claimKey(uploadType, filename)], arguments: [CONTRACT, token]
  });
  if (result !== 'RELEASED') throw protocolError(result, 'deletion release');
}

module.exports = {
  isCustomRecipeAsset,
  claimCustomRecipePublication,
  releaseCustomRecipePublication,
  reserveCustomRecipeDeletion,
  beginCustomRecipeDeletion,
  finishCustomRecipeDeletion
};
