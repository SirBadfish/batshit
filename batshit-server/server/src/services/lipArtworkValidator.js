const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const CONTRACT = 'lip-artwork/v2';
const PUBLIC_PREFIX = 'goons/lip-artwork/v2/';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set([
  'batshit-original',
  'user-authored',
  'comfyui-generated',
  'approved-external'
]);

let cachedContract = null;

class LipArtworkValidationError extends Error {
  constructor(message) {
    super(`[lip-artwork/v2] ${message}`);
    this.name = 'LipArtworkValidationError';
    this.statusCode = 400;
  }
}

function fail(message) {
  throw new LipArtworkValidationError(message);
}

function failPackage(message) {
  throw new Error(`[lip-artwork/v2] ${message}`);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolveAssetRoot() {
  return (
    process.env.BATSHIT_LIP_ARTWORK_ASSET_ROOT ||
    path.resolve(__dirname, '../../../../batshit-app/static/goons/lip-artwork/v2')
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
  const contractPath = path.join(root, 'lip-artwork-v2.json');
  let raw;
  try {
    raw = await fs.readFile(contractPath, 'utf8');
  } catch (error) {
    throw new Error(
      `[lip-artwork/v2] trusted validator assets are unavailable at ${contractPath}: ${error.message}`
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
    contract?.stateSchemaVersion !== 'lip-artwork-state/v2' ||
    contract?.productExportApproved !== true ||
    !HASH_PATTERN.test(contract?.definitionSha256 || '')
  ) {
    throw new Error('[lip-artwork/v2] trusted validator definition is unsupported');
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

async function trustedMask(root, record, width, height, label) {
  const bytes = await fs.readFile(resolveContractAsset(root, record.path));
  if (sha256(bytes) !== record.sha256) {
    throw new Error(`[lip-artwork/v2] trusted ${label} hash drifted`);
  }
  const mask = await sharp(bytes, { failOn: 'error' }).greyscale().raw().toBuffer();
  if (mask.length !== width * height) {
    throw new Error(`[lip-artwork/v2] trusted ${label} dimensions drifted`);
  }
  return mask;
}

async function prepareLipArtworkUpload(input) {
  const { root, contract } = await loadContract();
  const trustedTemplate = contract.template;
  if (
    !HASH_PATTERN.test(input.definitionSha256 || '') ||
    typeof input.templateId !== 'string' ||
    !input.templateId.trim() ||
    typeof input.templateVersion !== 'string' ||
    !input.templateVersion.trim() ||
    !HASH_PATTERN.test(input.guideSha256 || '') ||
    !HASH_PATTERN.test(input.maskSha256 || '') ||
    !HASH_PATTERN.test(input.baseLipReferenceMaskSha256 || '') ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height)
  ) {
    failPackage('the installed Goon supplied incomplete Lip Artwork package metadata');
  }
  if (
    input.width !== trustedTemplate.dimensions[0] ||
    input.height !== trustedTemplate.dimensions[1] ||
    input.maskSha256 !== trustedTemplate.safePaintMask.sha256
  ) {
    failPackage('the installed Goon uses an unsupported Lip Artwork safety boundary');
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
  const safeMask = await trustedMask(
    root,
    trustedTemplate.safePaintMask,
    width,
    height,
    'safe mask'
  );
  const rgba = Buffer.from(decoded.data);
  let clippedAlphaPixels = 0;
  let paintedPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const sourceAlpha = rgba[offset + 3];
    const preparedAlpha = Math.min(sourceAlpha, safeMask[pixel]);
    if (preparedAlpha !== sourceAlpha) clippedAlphaPixels += 1;
    rgba[offset + 3] = preparedAlpha;
    if (preparedAlpha > 1) paintedPixels += 1;
    if (preparedAlpha === 0) rgba.fill(0, offset, offset + 3);
  }
  if (paintedPixels === 0) fail('artwork alpha is empty');
  const buffer = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ progressive: false, compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  const provenance = parseProvenance(input.provenance);
  const artwork = {
    definitionSha256: input.definitionSha256,
    template: {
      id: input.templateId,
      version: input.templateVersion,
      guideSha256: input.guideSha256,
      maskSha256: input.maskSha256,
      baseLipReferenceMaskSha256: input.baseLipReferenceMaskSha256
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

function clearLipArtworkContractCacheForTests() {
  cachedContract = null;
}

module.exports = {
  LipArtworkValidationError,
  clearLipArtworkContractCacheForTests,
  prepareLipArtworkUpload
};
