const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const CONTRACT = 'skin-appearance/v1';
const ARTWORK_CONTRACT = 'skin-surface-artwork/v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAP_ROLES = new Set(['baseColor', 'normal', 'roughness', 'metallic']);
const SOURCE_KINDS = new Set([
  'batshit-original',
  'user-authored',
  'comfyui-generated',
  'approved-external'
]);
const LINEAR_MAP_SIZE = 2048;
const MAX_INVALID_NORMAL_VECTOR_RATE = 0.0001;
const MAX_BACKWARD_NORMAL_VECTOR_REPAIR_RATE = 0.001;

let cachedContract = null;

class SkinSurfaceArtworkValidationError extends Error {
  constructor(message) {
    super(`[skin-surface-artwork/v1] ${message}`);
    this.name = 'SkinSurfaceArtworkValidationError';
    this.statusCode = 400;
  }
}

function fail(message) {
  throw new SkinSurfaceArtworkValidationError(message);
}

function failPackage(message) {
  throw new Error(`[skin-surface-artwork/v1] ${message}`);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolveContractPath() {
  if (process.env.BATSHIT_SKIN_APPEARANCE_CONTRACT_PATH) {
    return process.env.BATSHIT_SKIN_APPEARANCE_CONTRACT_PATH;
  }
  if (process.env.BATSHIT_SKIN_APPEARANCE_ASSET_ROOT) {
    return path.join(
      process.env.BATSHIT_SKIN_APPEARANCE_ASSET_ROOT,
      'skin-appearance-v1.json'
    );
  }
  return path.resolve(
    __dirname,
    '../../../../batshit-app/static/goons/skin-appearance/v1/skin-appearance-v1.json'
  );
}

function resolvePublicAssetPath(contractPath, assetPath) {
  const staticRoot = path.resolve(path.dirname(contractPath), '../../..');
  return path.resolve(staticRoot, assetPath);
}

async function loadContract() {
  const contractPath = resolveContractPath();
  let raw;
  try {
    raw = await fs.readFile(contractPath, 'utf8');
  } catch (error) {
    throw new Error(
      `[skin-surface-artwork/v1] trusted validator definition is unavailable at ${contractPath}: ${error.message}`
    );
  }
  const sourceSha256 = sha256(raw);
  if (
    cachedContract?.contractPath === contractPath &&
    cachedContract.sourceSha256 === sourceSha256
  ) {
    return cachedContract.contract;
  }
  const contract = JSON.parse(raw);
  if (
    contract?.schemaVersion !== CONTRACT ||
    contract?.productExportApproved !== true ||
    !HASH_PATTERN.test(contract?.definitionSha256 || '') ||
    !Number.isSafeInteger(contract?.canvas?.width) ||
    !Number.isSafeInteger(contract?.canvas?.height) ||
    contract?.canvas?.colorSpace !== 'srgb' ||
    contract?.canvas?.flipY !== false
  ) {
    throw new Error('[skin-surface-artwork/v1] trusted validator definition is unsupported');
  }
  cachedContract = { contractPath, sourceSha256, contract };
  return contract;
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
  if (!SOURCE_KINDS.has(provenance.sourceKind)) {
    fail('provenance sourceKind is not allowed');
  }
  if (typeof provenance.author !== 'string' || !provenance.author.trim()) {
    fail('provenance author is required');
  }
  if (typeof provenance.license !== 'string' || !provenance.license.trim()) {
    fail('provenance license is required');
  }
  if (provenance.rightsConfirmed !== true) {
    fail('provenance rightsConfirmed must be true');
  }
  return {
    sourceKind: provenance.sourceKind,
    author: provenance.author.trim(),
    license: provenance.license.trim(),
    rightsConfirmed: true
  };
}

async function readPngMetadata(buffer, limitInputPixels) {
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error', limitInputPixels }).metadata();
  } catch {
    fail('artwork must be a readable PNG');
  }
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) {
    fail('artwork must be a single-frame PNG');
  }
  return metadata;
}

async function prepareBaseColor(buffer, contract) {
  const width = contract.canvas.width;
  const height = contract.canvas.height;
  const metadata = await readPngMetadata(buffer, width * height);
  if (metadata.width !== width || metadata.height !== height) {
    fail(`Base Color artwork must be a single-frame ${width}x${height} PNG`);
  }
  if (metadata.depth !== 'uchar' || (metadata.bitsPerSample ?? 8) > 8) {
    fail('Base Color artwork must use 8-bit RGB or RGBA channels');
  }

  let decoded;
  try {
    decoded = await sharp(buffer, { failOn: 'error', limitInputPixels: width * height })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
  } catch {
    fail('Base Color artwork could not be converted to canonical sRGB RGBA8');
  }
  if (decoded.info.channels !== 4) {
    fail('Base Color artwork could not be prepared as RGBA8');
  }
  const prepared = await sharp(decoded.data, {
    raw: { width, height, channels: 4 }
  })
    .png({ progressive: false, compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  return {
    buffer: prepared,
    canvas: {
      width,
      height,
      colorSpace: 'srgb',
      flipY: false,
      encoding: 'rgba8'
    },
    validation: { sourceDepth: metadata.depth, sourceChannels: metadata.channels }
  };
}

function decodeNormalChannel(value) {
  return (value / 255) * 2 - 1;
}

function encodeNormalChannel(value) {
  return Math.max(0, Math.min(255, Math.round((value * 0.5 + 0.5) * 255)));
}

async function loadSkinOwnershipMask(contract, contractPath, size) {
  const maskIds = [
    'generalSkin',
    'nipplesAreolae',
    'palmsSoles',
    'cheekBlush'
  ];
  const union = new Uint8Array(size * size);
  for (const id of maskIds) {
    const asset = contract?.masks?.[id];
    if (!asset?.path || !HASH_PATTERN.test(asset?.sha256 || '')) {
      failPackage(`trusted Skin Appearance ${id} mask is unavailable`);
    }
    const assetPath = resolvePublicAssetPath(contractPath, asset.path);
    let bytes;
    try {
      bytes = await fs.readFile(assetPath);
    } catch (error) {
      failPackage(`trusted Skin Appearance ${id} mask is unavailable at ${assetPath}: ${error.message}`);
    }
    if (sha256(bytes) !== asset.sha256) {
      failPackage(`trusted Skin Appearance ${id} mask hash does not match its definition`);
    }
    const decoded = await sharp(bytes, { failOn: 'error' })
      .resize(size, size, { fit: 'fill', kernel: sharp.kernel.nearest })
      .ensureAlpha()
      .extractChannel(3)
      .raw({ depth: 'uchar' })
      .toBuffer();
    for (let index = 0; index < union.length; index += 1) {
      union[index] = Math.max(union[index], decoded[index]);
    }
  }
  return union;
}

async function prepareNormal(buffer, contract, contractPath) {
  const metadata = await readPngMetadata(buffer, 4096 * 4096);
  if (
    metadata.width !== metadata.height ||
    (metadata.width !== LINEAR_MAP_SIZE && metadata.width !== LINEAR_MAP_SIZE * 2)
  ) {
    fail('Normal artwork must be a 2048x2048 or 4096x4096 PNG');
  }
  if (metadata.channels < 3) {
    fail('Normal artwork must contain RGB direction channels');
  }

  let decoded;
  try {
    decoded = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: metadata.width * metadata.height
    })
      .removeAlpha()
      .raw({ depth: 'float' })
      .toBuffer({ resolveWithObject: true });
  } catch {
    fail('Normal artwork could not be decoded without color conversion');
  }
  if (decoded.info.channels !== 3) {
    fail('Normal artwork could not be prepared as RGB direction data');
  }

  const source = new Float32Array(
    decoded.data.buffer,
    decoded.data.byteOffset,
    decoded.data.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  const sourceSize = decoded.info.width;
  const scale = sourceSize / LINEAR_MAP_SIZE;
  const sourceOwnership = await loadSkinOwnershipMask(contract, contractPath, sourceSize);
  const outputOwnership =
    scale === 1
      ? sourceOwnership
      : await loadSkinOwnershipMask(contract, contractPath, LINEAR_MAP_SIZE);
  const output = Buffer.allocUnsafe(LINEAR_MAP_SIZE * LINEAR_MAP_SIZE * 3);
  let invalidVectors = 0;
  let negativeZVectors = 0;
  let ownedSourceSamples = 0;
  let outsideFlattened = 0;
  let ownedPixels = 0;
  let minimumZ = 1;

  for (let y = 0; y < LINEAR_MAP_SIZE; y += 1) {
    for (let x = 0; x < LINEAR_MAP_SIZE; x += 1) {
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let acceptedSamples = 0;
      const outputPixel = y * LINEAR_MAP_SIZE + x;
      const ownedOutput = outputOwnership[outputPixel] > 0;
      if (ownedOutput) ownedPixels += 1;
      for (let offsetY = 0; offsetY < scale; offsetY += 1) {
        for (let offsetX = 0; offsetX < scale; offsetX += 1) {
          const sourcePixel =
            (y * scale + offsetY) * sourceSize + (x * scale + offsetX);
          const sourceIndex = sourcePixel * 3;
          const ownedSource = ownedOutput && sourceOwnership[sourcePixel] > 0;
          if (ownedSource) ownedSourceSamples += 1;
          const vectorX = decodeNormalChannel(source[sourceIndex]);
          const vectorY = decodeNormalChannel(source[sourceIndex + 1]);
          const vectorZ = decodeNormalChannel(source[sourceIndex + 2]);
          const length = Math.hypot(vectorX, vectorY, vectorZ);
          if (!Number.isFinite(length) || length < 0.1) {
            if (ownedSource) invalidVectors += 1;
            continue;
          }
          let normalizedX = vectorX / length;
          let normalizedY = vectorY / length;
          let normalizedZ = vectorZ / length;
          if (normalizedZ < -0.01) {
            if (ownedSource) negativeZVectors += 1;
            // Isolated filtered edge pixels can cross the tangent plane in an
            // otherwise valid export. Reflect only Z into the forward
            // hemisphere; the XY slope remains intact and the repair count is
            // retained in the canonicalization proof.
            normalizedZ = Math.abs(normalizedZ);
          }
          if (ownedOutput && sourceOwnership[sourcePixel] === 0) continue;
          sumX += normalizedX;
          sumY += normalizedY;
          sumZ += normalizedZ;
          acceptedSamples += 1;
        }
      }
      const length = Math.hypot(sumX, sumY, sumZ);
      if (!Number.isFinite(length) || length < 0.1 || acceptedSamples === 0) {
        if (ownedOutput) invalidVectors += 1;
        else outsideFlattened += 1;
        sumX = 0;
        sumY = 0;
        sumZ = 1;
      } else {
        sumX /= length;
        sumY /= length;
        sumZ /= length;
      }
      if (ownedOutput) minimumZ = Math.min(minimumZ, sumZ);
      const outputIndex = (y * LINEAR_MAP_SIZE + x) * 3;
      output[outputIndex] = encodeNormalChannel(sumX);
      output[outputIndex + 1] = encodeNormalChannel(sumY);
      output[outputIndex + 2] = encodeNormalChannel(sumZ);
    }
  }

  const invalidVectorRate = invalidVectors / Math.max(ownedPixels, 1);
  const backwardVectorRepairRate = negativeZVectors / Math.max(ownedSourceSamples, 1);
  if (invalidVectorRate > MAX_INVALID_NORMAL_VECTOR_RATE) {
    fail('Normal artwork contains too many zero-length or invalid direction vectors');
  }
  if (backwardVectorRepairRate > MAX_BACKWARD_NORMAL_VECTOR_REPAIR_RATE) {
    fail(
      `Normal artwork contains too many backward-facing tangent directions to repair safely (${negativeZVectors} of ${ownedSourceSamples} owned samples)`
    );
  }

  const prepared = await sharp(output, {
    raw: { width: LINEAR_MAP_SIZE, height: LINEAR_MAP_SIZE, channels: 3 }
  })
    .png({ progressive: false, compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  return {
    buffer: prepared,
    canvas: {
      width: LINEAR_MAP_SIZE,
      height: LINEAR_MAP_SIZE,
      colorSpace: 'linear',
      flipY: false,
      encoding: 'rgb8-normal-opengl'
    },
    validation: {
      sourceWidth: sourceSize,
      sourceDepth: metadata.depth,
      sourceChannels: metadata.channels,
      vectorAwareDownsample: scale === 2,
      minimumZ,
      ownedPixels,
      ownedSourceSamples,
      invalidVectors,
      invalidVectorRate,
      negativeZVectors,
      backwardVectorRepairs: negativeZVectors,
      backwardVectorRepairRate,
      maximumBackwardVectorRepairRate: MAX_BACKWARD_NORMAL_VECTOR_REPAIR_RATE,
      outsideFlattened
    }
  };
}

async function prepareScalarMap(buffer, role) {
  const metadata = await readPngMetadata(buffer, 4096 * 4096);
  if (
    metadata.width !== metadata.height ||
    (metadata.width !== LINEAR_MAP_SIZE && metadata.width !== LINEAR_MAP_SIZE * 2)
  ) {
    fail(`${role} artwork must be a 2048x2048 or 4096x4096 PNG`);
  }
  let decoded;
  try {
    decoded = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: metadata.width * metadata.height
    })
      .greyscale()
      .resize(LINEAR_MAP_SIZE, LINEAR_MAP_SIZE, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3
      })
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
  } catch {
    fail(`${role} artwork could not be converted to canonical linear grayscale`);
  }
  if (decoded.info.channels !== 1) {
    fail(`${role} artwork could not be prepared as grayscale`);
  }

  const packed = Buffer.allocUnsafe(LINEAR_MAP_SIZE * LINEAR_MAP_SIZE * 3);
  for (let index = 0; index < decoded.data.length; index += 1) {
    const outputIndex = index * 3;
    const value = decoded.data[index];
    packed[outputIndex] = 255;
    packed[outputIndex + 1] = role === 'roughness' ? value : 255;
    packed[outputIndex + 2] = role === 'metallic' ? value : 0;
  }
  const prepared = await sharp(packed, {
    raw: { width: LINEAR_MAP_SIZE, height: LINEAR_MAP_SIZE, channels: 3 }
  })
    .png({ progressive: false, compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  return {
    buffer: prepared,
    canvas: {
      width: LINEAR_MAP_SIZE,
      height: LINEAR_MAP_SIZE,
      colorSpace: 'linear',
      flipY: false,
      encoding: role === 'roughness' ? 'rgb8-roughness-g' : 'rgb8-metallic-b'
    },
    validation: {
      sourceWidth: metadata.width,
      sourceDepth: metadata.depth,
      sourceChannels: metadata.channels
    }
  };
}

async function prepareSkinSurfaceArtworkUpload(input) {
  const contract = await loadContract();
  const contractPath = resolveContractPath();
  if (!MAP_ROLES.has(input.map)) fail('map role is unsupported');
  if (!HASH_PATTERN.test(input.definitionSha256 || '')) {
    failPackage('the installed Goon uses an unsupported Skin Appearance identity');
  }

  const canonical =
    input.map === 'baseColor'
      ? await prepareBaseColor(input.buffer, contract)
      : input.map === 'normal'
        ? await prepareNormal(input.buffer, contract, contractPath)
        : await prepareScalarMap(input.buffer, input.map);
  const provenance = parseProvenance(input.provenance);
  const artwork = {
    schemaVersion: ARTWORK_CONTRACT,
    map: input.map,
    definitionSha256: input.definitionSha256,
    canvas: canonical.canvas,
    provenance,
    sha256: sha256(canonical.buffer),
    mimeType: 'image/png'
  };
  return {
    buffer: canonical.buffer,
    artwork,
    preparation: {
      sourceSha256: sha256(input.buffer),
      canonicalSha256: artwork.sha256,
      validation: canonical.validation
    }
  };
}

function clearSkinSurfaceArtworkContractCacheForTests() {
  cachedContract = null;
}

module.exports = {
  SkinSurfaceArtworkValidationError,
  clearSkinSurfaceArtworkContractCacheForTests,
  prepareSkinSurfaceArtworkUpload
};
