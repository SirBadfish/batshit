const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const zlib = require('zlib');

const CONTRACT = 'facial-artwork/v3';
const PUBLIC_PREFIX = 'goons/facial-artwork/v3/';
const ROLE_IDS = [
  'brows',
  'lashes_eye_outline',
  'iris',
  'pupil',
  'eye_highlight',
  'sclera'
];
const SOURCE_KINDS = new Set([
  'batshit-original',
  'user-authored',
  'comfyui-generated',
  'approved-external'
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let cachedContract = null;

class FacialArtworkValidationError extends Error {
  constructor(message) {
    super(`[facial-artwork/v3] ${message}`);
    this.name = 'FacialArtworkValidationError';
    this.statusCode = 400;
  }
}

function fail(message) {
  throw new FacialArtworkValidationError(message);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolveAssetRoot() {
  const candidates = [
    process.env.BATSHIT_FACIAL_ARTWORK_ASSET_ROOT,
    path.resolve(__dirname, '../../../../batshit-app/static/goons/facial-artwork/v3')
  ].filter(Boolean);
  return candidates[0];
}

function resolveContractAsset(root, publicPath) {
  if (
    typeof publicPath !== 'string' ||
    !publicPath.startsWith(PUBLIC_PREFIX) ||
    publicPath.includes('\\') ||
    publicPath.split('/').includes('..') ||
    publicPath.includes('_private')
  ) {
    fail('contract contains a non-public asset path');
  }
  const relative = publicPath.slice(PUBLIC_PREFIX.length);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail('contract asset path escapes its trusted root');
  }
  return resolved;
}

async function loadContract() {
  if (cachedContract) return cachedContract;
  const root = resolveAssetRoot();
  const contractPath = path.join(root, 'facial-artwork-v3.json');
  let raw;
  try {
    raw = await fs.readFile(contractPath, 'utf8');
  } catch (error) {
    throw new Error(
      `[facial-artwork/v3] trusted validator assets are unavailable at ${contractPath}: ${error.message}`
    );
  }
  let contract;
  try {
    contract = JSON.parse(raw);
  } catch {
    throw new Error('[facial-artwork/v3] trusted validator definition is invalid JSON');
  }
  if (contract?.schemaVersion !== CONTRACT || !HASH_PATTERN.test(contract?.definitionSha256 || '')) {
    throw new Error('[facial-artwork/v3] trusted validator definition has an unsupported contract');
  }
  if (
    !Array.isArray(contract.roles) ||
    contract.roles.map((role) => role?.id).join('|') !== ROLE_IDS.join('|')
  ) {
    throw new Error('[facial-artwork/v3] trusted validator role inventory drifted');
  }
  cachedContract = { root, contract };
  return cachedContract;
}

function parsePngChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('artwork content is not a PNG file');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) fail('PNG chunk framing is invalid');
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = zlib.crc32(buffer.subarray(offset + 4, dataEnd));
    if ((actualCrc >>> 0) !== expectedCrc) fail(`PNG ${type} chunk CRC is invalid`);
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (offset !== buffer.length || chunks.at(-1)?.type !== 'IEND') fail('PNG has trailing or missing data');
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
  if (!ihdr || ihdr.length !== 13) fail('PNG IHDR is missing or malformed');
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    interlace: ihdr[12],
    types: chunks.map((chunk) => chunk.type)
  };
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBytes, data])) >>> 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function declareCanonicalSrgb(buffer) {
  const chunks = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + length + 12;
    if (type !== 'sRGB' && type !== 'iCCP') chunks.push(buffer.subarray(offset, end));
    if (type === 'IHDR') chunks.push(pngChunk('sRGB', Buffer.from([0])));
    offset = end;
  }
  return Buffer.concat(chunks);
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

function resolveTemplateVariant(template, orientation) {
  if (orientation === template?.canonicalOrientation) {
    return {
      orientation,
      guide: template.guide,
      safePaintMask: template.safePaintMask,
      semanticMap: template.semanticMap
    };
  }
  if (
    orientation === 'anatomical-right' &&
    template?.canonicalOrientation === 'anatomical-left' &&
    template?.mirroredHorizontalVariant?.orientation === 'anatomical-right'
  ) {
    return template.mirroredHorizontalVariant;
  }
  fail(`template ${template?.id || 'unknown'} does not support orientation ${String(orientation)}`);
}

function validateAlpha(roleId, rgba, mask, width, height) {
  let painted = 0;
  let transparent = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const alpha = rgba[offset + 3];
    if (alpha === 0) {
      transparent += 1;
      if (rgba[offset] !== 0 || rgba[offset + 1] !== 0 || rgba[offset + 2] !== 0) {
        fail(`${roleId} has nonzero RGB in a fully transparent pixel`);
      }
    }
    if (alpha > mask[pixel]) fail(`${roleId} paints outside its safe mask`);
    if (alpha > 1) {
      painted += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (painted === 0) fail(`${roleId} artwork alpha is empty`);
  if (transparent === 0) fail(`${roleId} artwork must retain transparent pixels`);
  if (roleId === 'brows') {
    if (maxX - minX + 1 < width * 0.08 || maxY - minY + 1 < height * 0.02) {
      fail(`${roleId} alpha footprint is too small`);
    }
  }
}

function validateEyeSeams(roleId, rgba, width, height, template, semanticMap, palette) {
  if (roleId !== 'lashes_eye_outline') return;
  const tolerance = template.splits?.maximumJoinAlphaDelta;
  if (
    !Number.isInteger(tolerance) ||
    tolerance < 0 ||
    !Buffer.isBuffer(semanticMap) ||
    semanticMap.length !== width * height ||
    !palette ||
    !Number.isInteger(palette.inner_upper_transition) ||
    !Number.isInteger(palette.inner_lower_transition) ||
    !Number.isInteger(palette.outer_upper_transition) ||
    !Number.isInteger(palette.outer_lower_transition)
  ) {
    throw new Error('[facial-artwork/v3] trusted lashes/outline seam contract is malformed');
  }

  const joins = [
    {
      upper: palette.inner_upper_transition,
      lower: palette.inner_lower_transition,
      label: 'inner canthus'
    },
    {
      upper: palette.outer_upper_transition,
      lower: palette.outer_lower_transition,
      label: 'outer canthus'
    }
  ];
  const maximumAlpha = (region) => {
    let maximum = 0;
    let samples = 0;
    for (let pixel = 0; pixel < semanticMap.length; pixel += 1) {
      if (semanticMap[pixel] === region) {
        maximum = Math.max(maximum, rgba[pixel * 4 + 3]);
        samples += 1;
      }
    }
    if (samples === 0) {
      throw new Error(`[facial-artwork/v3] trusted lashes semantic region ${region} is empty`);
    }
    return maximum;
  };

  for (const join of joins) {
    const upper = maximumAlpha(join.upper);
    const lower = maximumAlpha(join.lower);
    if ((upper === 0) !== (lower === 0) || Math.abs(upper - lower) > tolerance) {
      fail(`${roleId} has a discontinuous ${join.label} upper/lower join`);
    }
  }
}

async function loadTrustedMask(root, template, variant) {
  const maskPath = resolveContractAsset(root, variant.safePaintMask.path);
  const maskBytes = await fs.readFile(maskPath);
  if (sha256(maskBytes) !== variant.safePaintMask.sha256) {
    throw new Error(`[facial-artwork/v3] trusted safe mask hash drifted for ${template.id}`);
  }
  const mask = await sharp(maskBytes, { failOn: 'error' }).greyscale().raw().toBuffer();
  const [width, height] = template.dimensions;
  if (mask.length !== width * height) {
    throw new Error(`[facial-artwork/v3] trusted safe mask channels drifted for ${template.id}`);
  }
  return mask;
}

async function loadTrustedSemanticMap(root, template, variant) {
  const record = variant.semanticMap;
  if (!record?.path || !record?.sha256 || record.channels !== 'L8' || !record.palette) {
    throw new Error(`[facial-artwork/v3] trusted semantic map is missing for ${template.id}`);
  }
  const semanticPath = resolveContractAsset(root, record.path);
  const semanticBytes = await fs.readFile(semanticPath);
  if (sha256(semanticBytes) !== record.sha256) {
    throw new Error(`[facial-artwork/v3] trusted semantic map hash drifted for ${template.id}`);
  }
  const semanticMap = await sharp(semanticBytes, { failOn: 'error' }).greyscale().raw().toBuffer();
  const [width, height] = template.dimensions;
  if (semanticMap.length !== width * height) {
    throw new Error(`[facial-artwork/v3] trusted semantic map channels drifted for ${template.id}`);
  }
  return { semanticMap, palette: record.palette };
}

async function prepareFacialArtworkUpload(input) {
  const { root, contract } = await loadContract();
  const roleId = String(input.role || '');
  const role = contract.roles.find((candidate) => candidate.id === roleId);
  if (!role) fail('role is unknown');
  if (input.definitionSha256 !== contract.definitionSha256) {
    fail('definitionSha256 does not match the current template definition');
  }
  const template = contract.templates.find((candidate) => candidate.id === role.template);
  const variant = resolveTemplateVariant(template, input.orientation);
  if (
    input.templateId !== template?.id ||
    input.templateVersion !== template?.version ||
    input.guideSha256 !== variant?.guide?.sha256 ||
    input.maskSha256 !== variant?.safePaintMask?.sha256
  ) {
    fail('template identity/version/orientation/guide/mask does not match the selected role');
  }
  const sourcePng = parsePngChunks(input.buffer);
  if (
    sourcePng.width !== template.dimensions[0] ||
    sourcePng.height !== template.dimensions[1]
  ) {
    fail(`${roleId} must use the exact ${template.dimensions.join('x')} template dimensions`);
  }
  if (sourcePng.bitDepth !== 8) {
    fail(`${roleId} must use 8-bit PNG channels`);
  }
  const sourceMetadata = await sharp(input.buffer, {
    failOn: 'error',
    limitInputPixels: 2048 * 2048
  }).metadata();
  if (
    sourceMetadata.format !== 'png' ||
    sourceMetadata.depth !== 'uchar' ||
    (sourceMetadata.pages ?? 1) !== 1
  ) {
    fail(`${roleId} must be a single-frame 8-bit PNG`);
  }

  const decoded = await sharp(input.buffer, {
    failOn: 'error',
    limitInputPixels: 2048 * 2048
  })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== sourcePng.width ||
    decoded.info.height !== sourcePng.height ||
    decoded.info.channels !== 4
  ) {
    fail(`${roleId} could not be prepared as RGBA artwork`);
  }

  const mask = await loadTrustedMask(root, template, variant);
  const semantic =
    roleId === 'lashes_eye_outline'
      ? await loadTrustedSemanticMap(root, template, variant)
      : null;
  const rgba = Buffer.from(decoded.data);
  let clippedAlphaPixels = 0;
  let clearedTransparentRgbPixels = 0;
  for (let pixel = 0; pixel < sourcePng.width * sourcePng.height; pixel += 1) {
    const offset = pixel * 4;
    const sourceAlpha = rgba[offset + 3];
    const preparedAlpha = Math.min(sourceAlpha, mask[pixel]);
    if (preparedAlpha !== sourceAlpha) clippedAlphaPixels += 1;
    rgba[offset + 3] = preparedAlpha;
    if (preparedAlpha === 0 && (rgba[offset] !== 0 || rgba[offset + 1] !== 0 || rgba[offset + 2] !== 0)) {
      rgba.fill(0, offset, offset + 3);
      clearedTransparentRgbPixels += 1;
    }
  }

  const encoded = await sharp(rgba, {
    raw: { width: sourcePng.width, height: sourcePng.height, channels: 4 }
  })
    .png({ progressive: false, compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  const buffer = declareCanonicalSrgb(encoded);
  const png = parsePngChunks(buffer);
  if (
    png.width !== template.dimensions[0] ||
    png.height !== template.dimensions[1] ||
    png.bitDepth !== 8 ||
    png.colorType !== 6 ||
    png.interlace !== 0 ||
    !png.types.includes('sRGB') ||
    png.types.includes('iCCP')
  ) {
    throw new Error(`[facial-artwork/v3] canonical PNG preparation drifted for ${roleId}`);
  }
  const canonicalMetadata = await sharp(buffer, {
    failOn: 'error',
    limitInputPixels: 2048 * 2048
  }).metadata();
  if (
    canonicalMetadata.format !== 'png' ||
    canonicalMetadata.channels !== 4 ||
    canonicalMetadata.depth !== 'uchar' ||
    canonicalMetadata.hasProfile === true
  ) {
    throw new Error(`[facial-artwork/v3] canonical decoder metadata drifted for ${roleId}`);
  }
  validateAlpha(roleId, rgba, mask, png.width, png.height);
  validateEyeSeams(
    roleId,
    rgba,
    png.width,
    png.height,
    template,
    semantic?.semanticMap,
    semantic?.palette
  );
  const provenance = parseProvenance(input.provenance);
  const artwork = {
    role: roleId,
    definitionSha256: contract.definitionSha256,
    template: {
      id: template.id,
      version: template.version,
      orientation: variant.orientation,
      guideSha256: variant.guide.sha256,
      maskSha256: variant.safePaintMask.sha256
    },
    provenance,
    sha256: sha256(buffer),
    width: png.width,
    height: png.height,
    mimeType: 'image/png'
  };
  return {
    buffer,
    artwork,
    preparation: {
      sourceSha256: sha256(input.buffer),
      canonicalSha256: artwork.sha256,
      colorSpaceNormalized:
        !sourcePng.types.includes('sRGB') || sourcePng.types.includes('iCCP'),
      clippedAlphaPixels,
      clearedTransparentRgbPixels
    }
  };
}

function clearFacialArtworkContractCacheForTests() {
  cachedContract = null;
}

module.exports = {
  FacialArtworkValidationError,
  clearFacialArtworkContractCacheForTests,
  prepareFacialArtworkUpload
};
