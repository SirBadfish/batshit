const { createHash } = require('node:crypto');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ROLES = { geometry: '.glb', 'follower-definition': '.json', 'physics-definition': '.json',
  'material-definition': '.json', 'neutral-value': '.png', 'highlight-mask': '.png', normal: '.png',
  roughness: '.png', preview: '.png', 'import-receipt': '.json', 'fit-receipt': '.json', 'refit-source': '.glb' };

function refused(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function candidateIds(job) {
  if (job.target?.kind === 'refit') {
    if (![job.target.assetId, job.target.revisionId].every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id))) throw refused('Hair import target is invalid.');
    return job.target;
  }
  if (job.target?.kind !== 'new') throw refused('Hair import target is invalid.');
  const assetId = `imported-hair-${job.jobId}`.toLowerCase();
  if (assetId.length > 77 || !/^[A-Za-z0-9_-]+$/.test(assetId)) throw refused('Hair import target is invalid.');
  return { assetId, revisionId: `${assetId}-r1` };
}

/** Called inside the file publication queue before its IO begins. A later
 * retirement waits behind this IO before discovering its creation receipt. */
async function admitHairImportUpload(client, receipt, expectedVersion) {
  if (!receipt) return;
  const version = Number(expectedVersion);
  if (!Number.isSafeInteger(version) || version < 1) throw refused('Hair import upload requires its current job version.');
  const job = await client.json.get(`hair_import_job:${receipt.userId}:${receipt.jobId}`);
  if (!job || job.contract !== 'hair-import-job/v4' || job.userId !== receipt.userId ||
      job.jobId !== receipt.jobId || job.stateVersion !== version ||
      !['preparing', 'reviewable'].includes(job.status) || !Number.isFinite(Date.parse(job.expiresAt)) ||
      Date.parse(job.expiresAt) <= Date.now()) throw refused('Hair import changed or expired. Reload before continuing.');
  const ids = candidateIds(job);
  if (ids.assetId !== receipt.assetId || ids.revisionId !== receipt.revisionId) {
    throw refused('Hair import artifact does not match the current job target.');
  }
}

async function materializeHairCleanupContext(client, context) {
  const hasRaw = context && Object.hasOwn(context, 'expectedRaw');
  const hasDigest = context && Object.hasOwn(context, 'expectedRawSha256');
  const hasVersion = context && Object.hasOwn(context, 'stateVersion');
  if (!context || typeof context.jobKey !== 'string' ||
      !/^hair_import_job:[A-Za-z0-9._:-]+$/.test(context.jobKey) ||
      !['retired', 'subset', 'source-consumed'].includes(context.mode) ||
      Number(hasRaw) + Number(hasDigest) + Number(hasVersion) !== 1 ||
      hasRaw && (typeof context.expectedRaw !== 'string' || context.expectedRaw.length === 0) ||
      hasDigest && (typeof context.expectedRawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(context.expectedRawSha256)) ||
      hasVersion && (!Number.isSafeInteger(context.stateVersion) || context.stateVersion < 1)) {
    throw refused('Hair cleanup context is invalid.');
  }
  const raw = await client.sendCommand(['JSON.GET', context.jobKey]);
  if (!raw || hasRaw && raw !== context.expectedRaw ||
      hasDigest && createHash('sha256').update(raw).digest('hex') !== context.expectedRawSha256) {
    throw refused('Hair import changed. Retry cleanup from its current state.');
  }
  const job = JSON.parse(raw);
  if (hasVersion && job.stateVersion !== context.stateVersion) throw refused('Hair import changed. Retry cleanup from its current state.');
  const { expectedRawSha256, ...atomicContext } = context;
  if (hasDigest) atomicContext.expectedRaw = raw;
  return { job, context: atomicContext };
}

async function assertHairCleanupContext(client, context) {
  return (await materializeHairCleanupContext(client, context)).job;
}

function cleanupFileFromContext(context, job, uploadType, filename) {
  const fields = ['uploadType', 'filename', 'ref', 'sha256', 'bytes', 'mimeType'];
  const file = Array.isArray(context.files) && context.files.find((file) => file?.uploadType === uploadType && file.filename === filename);
  if (!file || !Array.isArray(job.cleanupFiles) || !job.cleanupFiles.some((owned) =>
      owned && fields.every((field) => owned[field] === file[field])) ||
      context.mode === 'retired' && job.status !== 'cancelled' ||
      context.mode === 'source-consumed' && job.status !== 'reviewable') {
    throw refused('Hair cleanup no longer matches the exact observed owner. Retry from its current state.');
  }
  return file;
}

function importedFileForJob(record, filename, job) {
  const receipt = record?.hairImportUpload;
  const artifact = record?.hairAssetArtifact;
  const fields = ['contract', 'userId', 'jobId', 'assetId', 'revisionId', 'role', 'sha256', 'filename', 'bytes'];
  if (!receipt || Object.keys(receipt).length !== fields.length || fields.some((field) => !(field in receipt)) ||
      receipt.contract !== 'hair-import-upload/v1' || receipt.userId !== job.userId || receipt.jobId !== job.jobId ||
      !ID.test(receipt.userId) || !ID.test(receipt.jobId) || receipt.filename !== filename ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 ||
      !artifact || ['assetId', 'revisionId', 'role', 'sha256'].some((field) => artifact[field] !== receipt[field]) ||
      !Object.hasOwn(ROLES, receipt.role) || !/^[A-Za-z0-9_-]{1,80}$/.test(receipt.assetId) ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(receipt.revisionId) ||
      filename !== `${receipt.assetId}_${receipt.revisionId}_${receipt.role}_${receipt.sha256}${ROLES[receipt.role]}` ||
      record.uploadType !== 'goon_hair_assets' || record.filename !== filename || record.storage !== 'filesystem' ||
      record.relativePath !== `goon_hair_assets/${filename}` ||
      record.sha256 !== receipt.sha256 || record.size !== receipt.bytes || typeof record.mimetype !== 'string') return null;
  const ids = candidateIds(job);
  if (ids.assetId !== receipt.assetId || ids.revisionId !== receipt.revisionId) return null;
  return { uploadType: 'goon_hair_assets', filename, ref: `/uploads/goon_hair_assets/${filename}`,
    sha256: receipt.sha256, bytes: receipt.bytes, mimeType: record.mimetype };
}

module.exports = { admitHairImportUpload, assertHairCleanupContext, cleanupFileFromContext, importedFileForJob, candidateIds, materializeHairCleanupContext };
