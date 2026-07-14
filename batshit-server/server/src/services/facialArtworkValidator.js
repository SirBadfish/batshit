const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const CONTRACT = 'facial-artwork/v2';
const PUBLIC_PREFIX = 'goons/facial-artwork/v2/';
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
    super(`[facial-artwork/v2] ${message}`);
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
    path.resolve(__dirname, '../../../../batshit-app/static/goons/facial-artwork/v2')
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
  const contractPath = path.join(root, 'facial-artwork-v2.json');
  let raw;
  try {
    raw = await fs.readFile(contractPath, 'utf8');
  } catch (error) {
    throw new Error(
      `[facial-artwork/v2] trusted validator assets are unavailable at ${contractPath}: ${error.message}`
    );
  }
  let contract;
  try {
    contract = JSON.parse(raw);
  } catch {
    throw new Error('[facial-artwork/v2] trusted validator definition is invalid JSON');
  }
  if (contract?.schemaVersion !== CONTRACT || !HASH_PATTERN.test(contract?.definitionSha256 || '')) {
    throw new Error('[facial-artwork/v2] trusted validator definition has an unsupported contract');
  }
  if (
    !Array.isArray(contract.roles) ||
    contract.roles.map((role) => role?.id).join('|') !== ROLE_IDS.join('|')
  ) {
    throw new Error('[facial-artwork/v2] trusted validator role inventory drifted');
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
    const actualCrc = require('zlib').crc32(buffer.subarray(offset + 4, dataEnd));
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

function validateEyeSeams(roleId, rgba, width, template) {
  if (roleId !== 'lashes_eye_outline') return;
  const band = template.splits?.seamBandPixels;
  const tolerance = template.splits?.maximumJoinAlphaDelta;
  if (!Number.isInteger(band) || !Number.isInteger(tolerance)) {
    throw new Error('[facial-artwork/v2] trusted lashes/outline seam contract is malformed');
  }
  const pairs = [
    [0, width - 1, 'inner canthus'],
    [Math.floor(width / 2) - 1, Math.floor(width / 2), 'outer canthus']
  ];
  for (const [leftX, rightX, label] of pairs) {
    let left = 0;
    let right = 0;
    for (let y = 0; y < band; y += 1) {
      left = Math.max(left, rgba[(y * width + leftX) * 4 + 3]);
      right = Math.max(right, rgba[(y * width + rightX) * 4 + 3]);
    }
    if ((left === 0) !== (right === 0) || Math.abs(left - right) > tolerance) {
      fail(`${roleId} has a discontinuous ${label} upper/lower join`);
    }
  }
}

async function validateFacialArtworkUpload(input) {
  const { root, contract } = await loadContract();
  const roleId = String(input.role || '');
  const role = contract.roles.find((candidate) => candidate.id === roleId);
  if (!role) fail('role is unknown');
  if (input.definitionSha256 !== contract.definitionSha256) {
    fail('definitionSha256 does not match the current template definition');
  }
  const template = contract.templates.find((candidate) => candidate.id === role.template);
  if (
    input.templateId !== template?.id ||
    input.templateVersion !== template?.version ||
    input.guideSha256 !== template?.guide?.sha256
  ) {
    fail('template identity/version/guide hash does not match the selected role');
  }
  const png = parsePngChunks(input.buffer);
  if (
    png.width !== template.dimensions[0] ||
    png.height !== template.dimensions[1] ||
    png.bitDepth !== 8 ||
    png.colorType !== 6 ||
    png.interlace !== 0
  ) {
    fail(`${roleId} must be an exact ${template.dimensions.join('x')} non-interlaced RGBA8 PNG`);
  }
  if (!png.types.includes('sRGB') || png.types.includes('iCCP')) {
    fail(`${roleId} must declare canonical sRGB without an embedded ICC profile`);
  }
  const metadata = await sharp(input.buffer, { failOn: 'error', limitInputPixels: 2048 * 2048 })
    .metadata();
  if (metadata.format !== 'png' || metadata.channels !== 4 || metadata.depth !== 'uchar') {
    fail(`${roleId} decoder metadata is not RGBA8 PNG`);
  }
  const rgba = await sharp(input.buffer, { failOn: 'error', limitInputPixels: 2048 * 2048 })
    .raw()
    .toBuffer();
  const maskPath = resolveContractAsset(root, template.safePaintMask.path);
  const maskBytes = await fs.readFile(maskPath);
  if (sha256(maskBytes) !== template.safePaintMask.sha256) {
    throw new Error(`[facial-artwork/v2] trusted safe mask hash drifted for ${template.id}`);
  }
  const mask = await sharp(maskBytes, { failOn: 'error' }).greyscale().raw().toBuffer();
  if (mask.length !== png.width * png.height) {
    throw new Error(`[facial-artwork/v2] trusted safe mask channels drifted for ${template.id}`);
  }
  validateAlpha(roleId, rgba, mask, png.width, png.height);
  validateEyeSeams(roleId, rgba, png.width, template);
  const provenance = parseProvenance(input.provenance);
  return {
    role: roleId,
    definitionSha256: contract.definitionSha256,
    template: {
      id: template.id,
      version: template.version,
      guideSha256: template.guide.sha256
    },
    provenance,
    sha256: sha256(input.buffer),
    width: png.width,
    height: png.height,
    mimeType: 'image/png'
  };
}

function clearFacialArtworkContractCacheForTests() {
  cachedContract = null;
}

module.exports = {
  FacialArtworkValidationError,
  clearFacialArtworkContractCacheForTests,
  validateFacialArtworkUpload
};
