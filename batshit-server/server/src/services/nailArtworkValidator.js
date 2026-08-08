const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const CONTRACT = 'nail-surface/v1';
const ARTWORK_CONTRACT = 'nail-artwork/v1';
const PUBLIC_PREFIX = 'goons/nail-surface/v1/';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FAMILIES = new Set(['fingers', 'toes']);
const SOURCE_KINDS = new Set([
  'batshit-original',
  'user-authored',
  'comfyui-generated',
  'approved-external'
]);

let cachedContract = null;

class NailArtworkValidationError extends Error {
  constructor(message) {
    super(`[nail-artwork/v1] ${message}`);
    this.name = 'NailArtworkValidationError';
    this.statusCode = 400;
  }
}

function fail(message) {
  throw new NailArtworkValidationError(message);
}

function failPackage(message) {
  throw new Error(`[nail-artwork/v1] ${message}`);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolveAssetRoot() {
  return (
    process.env.BATSHIT_NAIL_SURFACE_ASSET_ROOT ||
    path.resolve(__dirname, '../../../../batshit-app/static/goons/nail-surface/v1')
  );
}

function resolveContractAsset(root, publicPath) {
  if (
    typeof publicPath !== 'string' ||
    !publicPath.startsWith(PUBLIC_PREFIX) ||
    publicPath.includes('\\') ||
    publicPath.split('/').includes('..')
  ) {
    failPackage('contract contains a non-public asset path');
  }
  const resolved = path.resolve(root, publicPath.slice(PUBLIC_PREFIX.length));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    failPackage('contract asset path escapes its trusted root');
  }
  return resolved;
}

async function loadContract() {
  const root = resolveAssetRoot();
  const contractPath = path.join(root, 'nail-surface-v1.json');
  let raw;
  try {
    raw = await fs.readFile(contractPath, 'utf8');
  } catch (error) {
    throw new Error(
      `[nail-artwork/v1] trusted validator assets are unavailable at ${contractPath}: ${error.message}`
    );
  }
  const sourceSha256 = sha256(raw);
  if (
    cachedContract?.contractPath === contractPath &&
    cachedContract.sourceSha256 === sourceSha256
  ) {
    return cachedContract;
  }
  const contract = JSON.parse(raw);
  if (
    contract?.schemaVersion !== CONTRACT ||
    contract?.artworkSchemaVersion !== ARTWORK_CONTRACT ||
    contract?.productExportApproved !== true ||
    !HASH_PATTERN.test(contract?.definitionSha256 || '') ||
    !contract?.templates?.fingers ||
    !contract?.templates?.toes
  ) {
    throw new Error('[nail-artwork/v1] trusted validator definition is unsupported');
  }
  cachedContract = { root, contractPath, sourceSha256, contract };
  return cachedContract;
}

function parseProvenance(value) {
  let provenance = value;
  if (typeof value === 'string') {
    try {
      provenance = JSON.parse(value);
    } catch {
      fail('provenance must be valid JSON');
    }
  }
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    fail('provenance must be an object');
  }
  if (!SOURCE_KINDS.has(provenance.sourceKind)) fail('provenance sourceKind is not allowed');
  if (typeof provenance.author !== 'string' || !provenance.author.trim()) {
    fail('provenance author is required');
  }
  if (typeof provenance.license !== 'string' || !provenance.license.trim()) {
    fail('provenance license is required');
  }
  if (provenance.rightsConfirmed !== true) fail('provenance rightsConfirmed must be true');
  return {
    sourceKind: provenance.sourceKind,
    author: provenance.author.trim(),
    license: provenance.license.trim(),
    rightsConfirmed: true
  };
}

async function trustedMask(root, record, width, height) {
  const bytes = await fs.readFile(resolveContractAsset(root, record.path));
  if (sha256(bytes) !== record.sha256) {
    throw new Error('[nail-artwork/v1] trusted slot-mask hash drifted');
  }
  const mask = await sharp(bytes, { failOn: 'error' }).greyscale().raw().toBuffer();
  if (mask.length !== width * height) {
    throw new Error('[nail-artwork/v1] trusted slot-mask dimensions drifted');
  }
  return mask;
}

async function prepareNailArtworkUpload(input) {
  const { root, contract } = await loadContract();
  if (!FAMILIES.has(input.family)) failPackage('the installed Goon supplied an invalid nail family');
  const template = contract.templates[input.family];
  if (
    !HASH_PATTERN.test(input.definitionSha256 || '') ||
    input.definitionSha256 !== contract.definitionSha256 ||
    input.templateId !== template.id ||
    input.templateVersion !== template.version ||
    input.guideSha256 !== template.guide.sha256 ||
    input.slotMaskSha256 !== template.slotMask.sha256 ||
    input.baseArtworkSha256 !== template.baseArtwork.sha256 ||
    input.width !== template.dimensions[0] ||
    input.height !== template.dimensions[1]
  ) {
    failPackage('the installed Goon uses an unsupported Nail Artwork template identity');
  }

  let metadata;
  try {
    metadata = await sharp(input.buffer, {
      failOn: 'error',
      limitInputPixels: input.width * input.height
    }).metadata();
  } catch {
    fail('artwork must be a readable PNG');
  }
  if (
    metadata.format !== 'png' ||
    metadata.width !== input.width ||
    metadata.height !== input.height ||
    (metadata.pages ?? 1) !== 1
  ) {
    fail(`artwork must be a single-frame ${input.width}x${input.height} PNG`);
  }

  let decoded;
  try {
    decoded = await sharp(input.buffer, {
      failOn: 'error',
      limitInputPixels: input.width * input.height
    })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    fail('artwork could not be converted to an 8-bit sRGB PNG');
  }
  if (decoded.info.channels !== 4) fail('artwork could not be prepared as RGBA');

  const width = decoded.info.width;
  const height = decoded.info.height;
  const slotMask = await trustedMask(root, template.slotMask, width, height);
  const rgba = Buffer.from(decoded.data);
  let clippedAlphaPixels = 0;
  let paintedPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const sourceAlpha = rgba[offset + 3];
    const preparedAlpha = Math.min(sourceAlpha, slotMask[pixel]);
    if (preparedAlpha !== sourceAlpha) clippedAlphaPixels += 1;
    rgba[offset + 3] = preparedAlpha;
    if (preparedAlpha > 1) paintedPixels += 1;
    if (preparedAlpha === 0) rgba.fill(0, offset, offset + 3);
  }
  if (paintedPixels === 0) fail('artwork alpha is empty inside the nail slots');

  const buffer = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ progressive: false, compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  const provenance = parseProvenance(input.provenance);
  const artwork = {
    schemaVersion: ARTWORK_CONTRACT,
    family: input.family,
    definitionSha256: input.definitionSha256,
    template: {
      id: input.templateId,
      version: input.templateVersion,
      guideSha256: input.guideSha256,
      slotMaskSha256: input.slotMaskSha256,
      baseArtworkSha256: input.baseArtworkSha256
    },
    provenance,
    sha256: sha256(buffer),
    width,
    height,
    mimeType: 'image/png'
  };
  return {
    buffer,
    artwork,
    preparation: {
      sourceSha256: sha256(input.buffer),
      canonicalSha256: artwork.sha256,
      clippedAlphaPixels,
      paintedPixels
    }
  };
}

function clearNailArtworkContractCacheForTests() {
  cachedContract = null;
}

module.exports = {
  NailArtworkValidationError,
  clearNailArtworkContractCacheForTests,
  prepareNailArtworkUpload
};
