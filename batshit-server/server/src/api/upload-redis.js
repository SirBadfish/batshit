// Redis-based file upload handler
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { unzipSync, strFromU8 } = require('fflate');
const config = require('../config');
const logger = require('../utils/logger');
const { writeErrorLog } = require('../utils/logSafety');
const batshitzipService = require('../services/batshitZipService');
const redisService = require('../services/redisService');
const { persistFileBackedUpload } = require('../services/fileBackedUploadService');
const uploadManager = require('../services/uploadManager');
const { prepareFacialArtworkUpload } = require('../services/facialArtworkValidator');
const { prepareLipArtworkUpload } = require('../services/lipArtworkValidator');
const { prepareNailArtworkUpload } = require('../services/nailArtworkValidator');
const {
  prepareSkinSurfaceArtworkUpload
} = require('../services/skinSurfaceArtworkValidator');
const {
  hashFile,
  inspectAndExtractRecipeArchive
} = require('../services/goonRecipeArchiveService');

const router = express.Router();
const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const GOON_CORE_IMPORT_MAX_FILE_SIZE = 600 * MIB;
const GOON_VRM_MAX_FILE_SIZE = GOON_CORE_IMPORT_MAX_FILE_SIZE;
const GOON_GUIDED_PACKAGE_MAX_FILE_SIZE = GOON_CORE_IMPORT_MAX_FILE_SIZE;
const GOON_CUSTOM_PACKAGE_MAX_FILE_SIZE = GOON_CORE_IMPORT_MAX_FILE_SIZE;
const GOON_ANIMATION_MAX_FILE_SIZE = 350 * MIB;
const GOON_IMAGE_UPLOAD_MAX_FILE_SIZE = 25 * MIB;
const GOON_SKIN_SURFACE_UPLOAD_MAX_FILE_SIZE = 100 * MIB;
const GOON_SCENE_UPLOAD_MAX_FILE_SIZE = 50 * MIB;
const GOON_SCENE_MODEL_UPLOAD_MAX_FILE_SIZE = 200 * MIB;
const GOON_ANIMATION_PREVIEW_MAX_FILE_SIZE = 40 * MIB;
const GENERIC_UPLOAD_BLOCKED_ARCHIVE_EXTENSIONS = new Set(['.zip', '.bgoon', '.rar', '.7z', '.tar', '.gz', '.tgz']);
const GENERIC_UPLOAD_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.htm', '.py', '.rb', '.go',
  '.rs', '.java', '.c', '.cpp', '.cs', '.php', '.sh', '.sql', '.log'
]);
const GENERIC_UPLOAD_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const GENERIC_UPLOAD_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const GENERIC_UPLOAD_DOCUMENT_EXTENSIONS = new Set(['.pdf']);
const GOON_ARCHIVE_MAX_ENTRIES = 16;
const GOON_MANIFEST_MAX_BYTES = 2 * MIB;

// Configure multer for memory storage instead of disk
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

const avatarUploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many avatar uploads. Please wait and try again.' }
});

const goonDiskUploadTempDir = path.join(config.uploadsDir, '_tmp');
fsSync.mkdirSync(goonDiskUploadTempDir, { recursive: true });

const goonDiskStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, goonDiskUploadTempDir);
  },
  filename: (_req, file, callback) => {
    const ext = path
      .extname(file.originalname || '')
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '');
    callback(null, `${Date.now()}_${crypto.randomUUID()}${ext}`);
  }
});

// Direct VRMs and Advanced/Blender packages can be very large, so they land on disk first.
const goonVrmUpload = multer({
  storage: goonDiskStorage,
  limits: {
    fileSize: GOON_VRM_MAX_FILE_SIZE
  }
});

const goonGuidedPackageUpload = multer({
  storage: goonDiskStorage,
  limits: {
    fileSize: GOON_GUIDED_PACKAGE_MAX_FILE_SIZE
  }
});

const goonCustomPackageUpload = multer({
  storage: goonDiskStorage,
  limits: {
    fileSize: GOON_CUSTOM_PACKAGE_MAX_FILE_SIZE
  }
});

const goonAnimationUpload = multer({
  storage,
  limits: {
    fileSize: GOON_ANIMATION_MAX_FILE_SIZE
  }
});

// Goon image uploads (closet textures)
const goonImageUpload = multer({
  storage,
  limits: {
    fileSize: GOON_IMAGE_UPLOAD_MAX_FILE_SIZE // 25MB limit
  }
});
const goonFacialArtworkUpload = multer({
  storage,
  limits: { fileSize: GOON_IMAGE_UPLOAD_MAX_FILE_SIZE }
});
const goonSkinSurfaceArtworkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: GOON_SKIN_SURFACE_UPLOAD_MAX_FILE_SIZE }
});

// Goon scene uploads (skybox images can be larger)
const goonSceneUpload = multer({
  storage,
  limits: {
    fileSize: GOON_SCENE_UPLOAD_MAX_FILE_SIZE // 50MB limit
  }
});

// Goon scene room shells (GLB/GLTF)
const goonSceneModelUpload = multer({
  storage,
  limits: {
    fileSize: GOON_SCENE_MODEL_UPLOAD_MAX_FILE_SIZE // 200MB limit
  }
});

const goonAnimationPreviewUpload = multer({
  storage,
  limits: {
    fileSize: GOON_ANIMATION_PREVIEW_MAX_FILE_SIZE // preview videos are short and should stay relatively small
  }
});

function formatUploadLimit(limitBytes) {
  if (limitBytes >= GIB && limitBytes % GIB === 0) {
    return `${limitBytes / GIB} GB`;
  }
  return `${Math.round(limitBytes / (1024 * 1024))} MB`;
}

function uploadValidationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendUploadError(res, fallbackMessage, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  return res.status(statusCode).json({
    error: statusCode === 500 ? fallbackMessage : error.message,
    ...(statusCode === 500 ? { details: error.message } : {})
  });
}

function resolveClipFileType(file, fileData) {
  if (fileData.textContent) return 'text';
  if (file.mimetype.startsWith('image/')) return 'image';
  if (file.mimetype.startsWith('video/')) return 'video';
  if (file.mimetype.includes('pdf')) return 'pdf';
  if (file.mimetype.startsWith('text/')) return 'text';
  return 'document';
}

function resolveClipMimeType(file, fileData) {
  if (!fileData.textContent) return file.mimetype;
  if (file.originalname.endsWith('.md')) return 'text/markdown';
  if (file.mimetype === 'application/octet-stream') return 'text/plain';
  return file.mimetype;
}

function buildPersistedClipUpload({ file, fileData, clipData, userId, compressionSettings }) {
  const storageMode = 'local';
  const clipFormatted = batshitzipService.formatAsClip(clipData, {
    externalUrl: null,
    storageMode
  });
  const textTokenCount = fileData.textContent
    ? Math.max(1, Math.ceil(fileData.textContent.length / 4))
    : null;
  const isImageUpload = file.mimetype.startsWith('image/');
  const externalTokens = isImageUpload ? 765 : null;
  const localTokens = isImageUpload
    ? 765
    : (textTokenCount ?? (fileData.base64 ? Math.ceil(fileData.base64.length / 4) : clipData.tokens));

  const clipRecord = {
    id: clipData.id,
    user_id: userId,
    filename: file.originalname,
    fileType: resolveClipFileType(file, fileData),
    mimeType: resolveClipMimeType(file, fileData),
    externalUrl: null,
    displayUrl: fileData.displayUrl || fileData.url,
    localUrl: fileData.displayUrl || fileData.url,
    tunnelPath: fileData.tunnelPath || null,
    externalTokens,
    localTokens,
    storageMode,
    localBase64: null,
    content: fileData.textContent || null,
    fileSize: fileData.size,
    uploadSettings: {
      destination: 'local',
      keepLocalCopy: compressionSettings.keep_local_copy || false,
      compressionQuality: compressionSettings.compression_quality,
      maxImageSize: compressionSettings.max_image_size,
      forceJpeg: compressionSettings.force_jpeg
    },
    thumbnailUrl: isImageUpload ? fileData.displayUrl || fileData.url : null,
    created_at: new Date().toISOString()
  };

  return {
    clipFormatted,
    clipRecord,
    externalTokens,
    localTokens,
    storageMode
  };
}

function detectUploadSignature(buffer) {
  if (!buffer || buffer.length < 4) return 'unknown';
  const ascii4 = buffer.subarray(0, 4).toString('ascii');

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'png';
  if (ascii4 === 'GIF8') return 'gif';
  if (ascii4 === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (ascii4 === '%PDF') return 'pdf';
  if (ascii4 === 'glTF') return 'glb';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2])) return 'zip';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm';
  return 'unknown';
}

function bufferLooksText(buffer) {
  if (!buffer || buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}

function validateGenericUploadFile(file) {
  const originalName = file?.originalname || 'upload';
  const ext = path.extname(originalName).toLowerCase();
  const mime = String(file?.mimetype || '').toLowerCase();
  const signature = detectUploadSignature(file?.buffer);

  if (GENERIC_UPLOAD_BLOCKED_ARCHIVE_EXTENSIONS.has(ext) || signature === 'zip') {
    throw uploadValidationError('Archives must use a dedicated Batshit package upload endpoint.');
  }

  if (mime === 'image/svg+xml' || ext === '.svg') {
    throw uploadValidationError('SVG uploads are not accepted because they can contain executable content.');
  }

  if (GENERIC_UPLOAD_IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/')) {
    const expected = ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext.replace('.', '');
    if (!['png', 'jpeg', 'gif', 'webp'].includes(signature)) {
      throw uploadValidationError('Image upload does not match an allowed image signature.');
    }
    if (expected && expected !== signature) {
      throw uploadValidationError(`Image extension does not match file content (${ext} vs ${signature}).`);
    }
    return;
  }

  if (GENERIC_UPLOAD_DOCUMENT_EXTENSIONS.has(ext) || mime === 'application/pdf') {
    if (signature !== 'pdf') {
      throw uploadValidationError('PDF upload does not match a PDF file signature.');
    }
    return;
  }

  if (GENERIC_UPLOAD_VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/')) {
    const validVideo =
      (ext === '.webm' && signature === 'webm') ||
      ((ext === '.mp4' || ext === '.mov') && signature === 'mp4');
    if (!validVideo) {
      throw uploadValidationError('Video upload does not match an allowed video signature.');
    }
    return;
  }

  if (GENERIC_UPLOAD_TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime.includes('json')) {
    if (!bufferLooksText(file.buffer)) {
      throw uploadValidationError('Text upload contains binary data.');
    }
    return;
  }

  throw uploadValidationError('Unsupported upload file type.');
}

async function detectUploadSignatureFromFile(file) {
  if (file?.buffer) return detectUploadSignature(file.buffer);
  if (!file?.path) return 'unknown';

  const safePath = resolveMulterDiskUploadPath(file);
  if (!safePath) return 'unknown';
  const handle = await fs.open(safePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return detectUploadSignature(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function resolveMulterDiskUploadPath(file) {
  if (!file?.filename || typeof file.filename !== 'string') return null;
  const filename = file.filename;
  for (const char of filename) {
    const safe =
      (char >= 'A' && char <= 'Z') ||
      (char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '_' ||
      char === '-' ||
      char === '.';
    if (!safe) {
      throw new Error('Upload temp filename contains unsafe characters.');
    }
  }

  const tempRoot = path.resolve(goonDiskUploadTempDir);
  const resolvedPath = path.resolve(tempRoot, filename);
  if (!resolvedPath.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error('Upload temp filename escaped the configured upload temp directory.');
  }
  return resolvedPath;
}

async function validateGoonBinaryUpload(file, { expectedExt, expectedSignature, label }) {
  const originalName = file?.originalname || label;
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== expectedExt) {
    throw uploadValidationError(`${label} files must use the ${expectedExt} extension.`);
  }

  const signature = await detectUploadSignatureFromFile(file);
  if (expectedSignature && signature !== expectedSignature) {
    throw uploadValidationError(`${label} file content does not match the expected ${expectedSignature} signature.`);
  }
}

function assertSafeArchiveEntryName(entryName, laneLabel) {
  const normalized = String(entryName || '').replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('../') ||
    normalized.includes('/..') ||
    path.isAbsolute(normalized)
  ) {
    throw uploadValidationError(`${laneLabel} package contains an unsafe archive entry path.`);
  }
  return normalized;
}

function readConstrainedGoonArchiveEntries(buffer, {
  laneLabel,
  allowedBasenames,
  maxUncompressedBytes
}) {
  const allowed = new Set(allowedBasenames.map((name) => name.toLowerCase()));
  const seenNames = [];
  const rejectedNames = [];
  let totalUncompressed = 0;

  const entries = unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      const entryName = assertSafeArchiveEntryName(file.name, laneLabel);
      if (entryName.endsWith('/')) return false;
      seenNames.push(entryName);
      if (seenNames.length > GOON_ARCHIVE_MAX_ENTRIES) {
        throw uploadValidationError(`${laneLabel} package has too many files.`);
      }

      const basename = getArchiveEntryBasename(entryName).toLowerCase();
      if (!allowed.has(basename)) {
        rejectedNames.push(entryName);
        return false;
      }

      totalUncompressed += file.originalSize || 0;
      if (totalUncompressed > maxUncompressedBytes) {
        throw uploadValidationError(`${laneLabel} package expands beyond the allowed size.`);
      }
      if (basename === 'avatar.json' && file.originalSize > GOON_MANIFEST_MAX_BYTES) {
        throw uploadValidationError(`${laneLabel} manifest is too large.`);
      }
      return true;
    }
  });

  if (rejectedNames.length > 0) {
    throw uploadValidationError(`${laneLabel} package contains unsupported files: ${rejectedNames.slice(0, 5).join(', ')}`);
  }

  return Object.entries(entries).filter(([entryName]) => entryName && !entryName.endsWith('/'));
}

function getUploadLimitForPath(reqPath) {
  switch (reqPath) {
    case '/upload/goon':
      return GOON_VRM_MAX_FILE_SIZE;
    case '/upload/goon-guided-package':
      return GOON_GUIDED_PACKAGE_MAX_FILE_SIZE;
    case '/upload/goon-custom-package':
      return GOON_CUSTOM_PACKAGE_MAX_FILE_SIZE;
    case '/upload/goon-animation':
      return GOON_ANIMATION_MAX_FILE_SIZE;
    case '/upload/goon-closet':
    case '/upload/goon-facial-artwork':
    case '/upload/goon-lip-artwork':
      return GOON_IMAGE_UPLOAD_MAX_FILE_SIZE;
    case '/upload/goon-scene':
    case '/upload/goon-room-texture':
      return GOON_SCENE_UPLOAD_MAX_FILE_SIZE;
    case '/upload/goon-room-shell':
    case '/upload/goon-scene-prop':
      return GOON_SCENE_MODEL_UPLOAD_MAX_FILE_SIZE;
    case '/upload/goon-animation-preview':
      return GOON_ANIMATION_PREVIEW_MAX_FILE_SIZE;
    default:
      return null;
  }
}

async function transcodeGoonAnimationPreviewToMp4(file) {
  const originalName = file.originalname || 'motion_preview.webm';
  const ext = path.extname(originalName).toLowerCase() || '.webm';
  const directMp4 = ext === '.mp4' && (file.mimetype === 'video/mp4' || !file.mimetype);

  if (directMp4) {
    return {
      buffer: file.buffer,
      size: file.size,
      mimetype: 'video/mp4',
      ext: '.mp4'
    };
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-goon-preview-'));
  const inputPath = path.join(tempRoot, `${crypto.randomUUID()}${ext}`);
  const outputPath = path.join(tempRoot, `${crypto.randomUUID()}.mp4`);
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const videoEncoder = process.env.BATSHIT_FFMPEG_H264_ENCODER || 'libx264';
  const encoderArgs =
    videoEncoder === 'h264_videotoolbox'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', process.env.BATSHIT_FFMPEG_H264_BITRATE || '900k']
      : ['-c:v', videoEncoder, '-preset', 'veryfast', '-crf', '30'];

  try {
    // Uploaded preview media is written only to a random server-owned temp path for ffmpeg conversion.
    // codeql[js/http-to-file-access]
    await fs.writeFile(inputPath, file.buffer);

    await execFileAsync(ffmpegPath, [
      '-y',
      '-i',
      inputPath,
      '-an',
      '-vf',
      'fps=24,scale=240:-2:flags=lanczos',
      ...encoderArgs,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath
    ]);

    const buffer = await fs.readFile(outputPath);
    return {
      buffer,
      size: buffer.length,
      mimetype: 'video/mp4',
      ext: '.mp4'
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function normalizeTunnelConfig(rawTunnelUrl, explicitHttps) {
  if (typeof rawTunnelUrl !== 'string') return null;
  const trimmed = rawTunnelUrl.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.host || parsed.hostname;
      if (!host) return null;
      return {
        host,
        useHttps: parsed.protocol === 'https:'
      };
    } catch (error) {
      logger.warn('[Upload] Failed to parse configured tunnel URL');
      return null;
    }
  }

  const normalizedHost = trimSlashes(trimmed);
  if (!normalizedHost) return null;
  return {
    host: normalizedHost,
    useHttps: explicitHttps === true
  };
}

function trimSlashes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

function normalizeLocalUploadSettings(uploadSettings = {}) {
  const normalized = {
    ...uploadSettings
  };

  normalized.strategy = 'local';
  normalized.storage_mode = 'local';
  return normalized;
}

function requireUploadUserId(req, res) {
  const userId = typeof req.body.userId === 'string' ? req.body.userId.trim() : '';
  if (!userId) {
    res.status(400).json({ error: 'Missing required userId' });
    return null;
  }
  return userId;
}

function readFirstStringField(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (Array.isArray(value)) {
      const nested = readFirstStringField(...value);
      if (nested) return nested;
    }
  }
  return '';
}

function isSafeFilenameChar(char) {
  return (
    (char >= 'A' && char <= 'Z') ||
    (char >= 'a' && char <= 'z') ||
    (char >= '0' && char <= '9') ||
    char === '_' ||
    char === '-'
  );
}

function sanitizeFilenameSegment(value, fallback = 'file') {
  let sanitized = '';
  let previousWasSeparator = false;
  for (const char of String(value || '')) {
    if (isSafeFilenameChar(char)) {
      sanitized += char;
      previousWasSeparator = char === '_';
      continue;
    }
    if (!previousWasSeparator) {
      sanitized += '_';
      previousWasSeparator = true;
    }
  }

  while (sanitized.startsWith('_')) sanitized = sanitized.slice(1);
  while (sanitized.endsWith('_')) sanitized = sanitized.slice(0, -1);

  return sanitized || fallback;
}

function buildSafeUploadFilename(originalName, fallbackBase = 'upload') {
  const normalizedName =
    typeof originalName === 'string' && originalName.trim() ? originalName.trim() : fallbackBase;
  const ext = path.extname(normalizedName).toLowerCase();
  const safeBase = sanitizeFilenameSegment(
    path.basename(normalizedName, ext),
    sanitizeFilenameSegment(fallbackBase, 'upload')
  );
  const safeExt = ext.replace(/[^a-z0-9.]+/g, '');

  return safeExt ? `${safeBase}${safeExt}` : safeBase;
}

function buildRedisUploadUrl(req, uploadType, filename) {
  return `${req.protocol}://${req.get('host')}/uploads/${uploadType}/${filename}`;
}

async function persistUploadPayload(redisKey, payload) {
  const stored = await redisService.setWithTTL(redisKey, payload, 0);
  if (!stored) {
    throw new Error('Upload storage unavailable. Redis is not writable yet. Please retry in a few seconds.');
  }
}

function validateUploadType(uploadType) {
  if (typeof uploadType !== 'string' || !/^[a-zA-Z0-9_]+$/.test(uploadType)) {
    throw new Error('Invalid upload type.');
  }
}

function validateStoredFilename(filename) {
  if (
    typeof filename !== 'string' ||
    !filename.trim() ||
    filename !== path.basename(filename) ||
    filename.includes('..')
  ) {
    throw new Error('Invalid upload filename.');
  }
}

function resolveStoredUploadPath(uploadType, filename) {
  validateUploadType(uploadType);
  validateStoredFilename(filename);

  const uploadRoot = path.resolve(config.uploadsDir);
  const resolvedPath = path.resolve(uploadRoot, uploadType, filename);
  if (!resolvedPath.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error('Upload path escaped the configured upload directory.');
  }
  return resolvedPath;
}

function resolveFileBackedPayloadPath(payload) {
  const uploadRoot = path.resolve(config.uploadsDir);
  const rawPath =
    typeof payload?.relativePath === 'string' && payload.relativePath
      ? path.resolve(uploadRoot, payload.relativePath)
      : typeof payload?.filePath === 'string'
        ? path.resolve(payload.filePath)
        : null;

  if (!rawPath) return null;
  if (!rawPath.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error('Stored upload path escaped the configured upload directory.');
  }
  return rawPath;
}

async function moveFileAcrossDevices(sourcePath, targetPath) {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await fs.copyFile(sourcePath, targetPath);
      await fs.rm(sourcePath, { force: true });
      return;
    }
    throw error;
  }
}

async function cleanupTempUploadFile(file) {
  const safePath = resolveMulterDiskUploadPath(file);
  if (safePath) {
    await fs.rm(safePath, { force: true }).catch(() => {});
  }
}

async function readUploadedFileBuffer(file) {
  if (file?.buffer) return file.buffer;
  const safePath = resolveMulterDiskUploadPath(file);
  if (safePath) return fs.readFile(safePath);
  return Buffer.alloc(0);
}

async function storeRedisUploadAsset(
  req,
  {
    uploadType,
    originalName,
    filename,
    mimetype,
    buffer,
    textContent,
    size
  }
) {
  const uploadedAt = new Date().toISOString();
  const resolvedSize =
    typeof size === 'number'
      ? size
      : typeof textContent === 'string'
        ? Buffer.byteLength(textContent)
        : buffer?.length || 0;

  const payload = {
    originalName,
    mimetype: mimetype || 'application/octet-stream',
    size: resolvedSize,
    uploadType,
    uploadedAt
  };

  if (typeof textContent === 'string') {
    payload.textContent = textContent;
  } else {
    payload.base64 = (buffer || Buffer.alloc(0)).toString('base64');
  }

  const redisKey = `upload:${uploadType}:${filename}`;
  await persistUploadPayload(redisKey, payload);

  return {
    filename,
    originalName,
    url: buildRedisUploadUrl(req, uploadType, filename),
    mimetype: payload.mimetype,
    size: resolvedSize,
    uploadedAt,
    redisKey
  };
}

async function storeFilesystemUploadAsset(
  req,
  {
    uploadType,
    originalName,
    filename,
    mimetype,
    sourceFile,
    buffer,
    size,
    metadata,
    redisKey: explicitRedisKey
  }
) {
  const uploadedAt = new Date().toISOString();
  const safeSourcePath = sourceFile ? resolveMulterDiskUploadPath(sourceFile) : null;
  const resolvedSize =
    typeof size === 'number'
      ? size
      : buffer?.length || (safeSourcePath ? (await fs.stat(safeSourcePath)).size : 0);
  const filePath = resolveStoredUploadPath(uploadType, filename);
  const basePayload = {
    originalName,
    mimetype: mimetype || 'application/octet-stream',
    size: resolvedSize,
    uploadType,
    uploadedAt,
    ...(metadata && typeof metadata === 'object' ? metadata : {})
  };
  const redisKey = explicitRedisKey || `upload:${uploadType}:${filename}`;

  if (!safeSourcePath) {
    const payload = await persistFileBackedUpload({
      redisService,
      redisKey,
      uploadType,
      filename,
      buffer: buffer || Buffer.alloc(0),
      payload: basePayload
    });
    return {
      filename,
      originalName,
      url: buildRedisUploadUrl(req, uploadType, filename),
      mimetype: payload.mimetype,
      size: payload.size,
      uploadedAt,
      redisKey,
      storage: 'filesystem',
      sha256: payload.sha256
    };
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  await moveFileAcrossDevices(safeSourcePath, filePath);

  const payload = {
    ...basePayload,
    storage: 'filesystem',
    relativePath: path.relative(config.uploadsDir, filePath),
    filePath
  };

  try {
    await persistUploadPayload(redisKey, payload);
  } catch (error) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    filename,
    originalName,
    url: buildRedisUploadUrl(req, uploadType, filename),
    mimetype: payload.mimetype,
    size: resolvedSize,
    uploadedAt,
    redisKey,
    storage: 'filesystem',
    ...(typeof payload.sha256 === 'string' ? { sha256: payload.sha256 } : {})
  };
}

async function deleteStoredUploadAsset(uploadType, filename) {
  validateUploadType(uploadType);
  validateStoredFilename(filename);

  const redisKey = `upload:${uploadType}:${filename}`;
  return deleteStoredUploadRecord(redisKey);
}

async function deleteStoredUploadRecord(redisKey) {
  const payload = await redisService.get(redisKey);
  const filePath = payload ? resolveFileBackedPayloadPath(payload) : null;
  const deleted = await redisService.client.del(redisKey);
  if (payload && deleted !== 1) {
    throw new Error(`Redis refused to delete upload metadata for ${redisKey}.`);
  }

  if (filePath) {
    await fs.rm(filePath, { force: true });
  }
  return {
    redisKey,
    existed: Boolean(payload),
    deletedFile: Boolean(filePath)
  };
}

async function buildGoonSceneThumbnail(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(480, 240, {
      fit: 'contain',
      background: { r: 12, g: 12, b: 12, alpha: 1 }
    })
    .jpeg({
      quality: 80,
      mozjpeg: true
    })
    .toBuffer();
}

function getArchiveEntryBasename(entryName) {
  return String(entryName || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() || '';
}

function parseManifestObject(text, laneLabel) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${laneLabel} manifest avatar.json must contain valid JSON.`);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${laneLabel} manifest avatar.json must contain a JSON object.`);
  }
  return manifest;
}

// R9 launches the automatic Recipe lifecycle only for product-owned bases that
// Batshit has proven end to end. Independent Advanced/GLB packages remain on
// their existing lane until an author contract is separately proven.
const FIRST_PARTY_RECIPE_BASE_IDS = new Set(['batshit-base-f-v1']);

function parseManifestSummary(manifest, laneLabel) {
  const contractVersionRaw = manifest.contractVersion;
  if (
    contractVersionRaw !== undefined &&
    (!Number.isInteger(contractVersionRaw) || contractVersionRaw < 1)
  ) {
    throw new Error(`${laneLabel} manifest contractVersion must be a positive integer.`);
  }

  const trimmedName =
    typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : undefined;
  const trimmedDescription =
    typeof manifest.description === 'string' && manifest.description.trim()
      ? manifest.description.trim()
      : undefined;

  return {
    summary: {
      contractVersion: typeof contractVersionRaw === 'number' ? contractVersionRaw : 1,
      name: trimmedName,
      description: trimmedDescription,
      ...(laneLabel === 'Custom Goon'
        ? {
            baseId:
              manifest.recipeSource !== null &&
              typeof manifest.recipeSource === 'object' &&
              !Array.isArray(manifest.recipeSource) &&
              typeof manifest.recipeSource.baseId === 'string'
                ? manifest.recipeSource.baseId
                : undefined,
            recipeReady:
              manifest.recipeSource !== null &&
              typeof manifest.recipeSource === 'object' &&
              !Array.isArray(manifest.recipeSource) &&
              manifest.recipeSource.contract === 'recipe-source/v1' &&
              FIRST_PARTY_RECIPE_BASE_IDS.has(manifest.recipeSource.baseId) &&
              manifest.recipeSource.fitFamily === manifest.recipeSource.baseId &&
              manifest.appearanceDials !== null &&
              typeof manifest.appearanceDials === 'object' &&
              !Array.isArray(manifest.appearanceDials) &&
              manifest.appearanceDials.contract === 'appearance-dials/v2' &&
              manifest.recipeUpdates !== null &&
              typeof manifest.recipeUpdates === 'object' &&
              !Array.isArray(manifest.recipeUpdates) &&
              manifest.recipeUpdates.contract === 'recipe-updates/v1' &&
              !Object.prototype.hasOwnProperty.call(manifest, 'liveBuild'),
            anatomyFitReady:
              manifest.anatomyFit !== null &&
              typeof manifest.anatomyFit === 'object' &&
              !Array.isArray(manifest.anatomyFit) &&
              manifest.anatomyFit.contract === 'anatomy-fit-manifest/v2'
          }
        : {})
    }
  };
}

function parseCustomGoonManifest(text) {
  const manifest = parseManifestObject(text, 'Custom Goon');
  return {
    manifest,
    ...parseManifestSummary(manifest, 'Custom Goon')
  };
}

function slugifyGuidedOutfitId(value, fallbackPrefix, index) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (normalized) return normalized;
  return `${fallbackPrefix}_${index + 1}`;
}

function normalizeGuidedRuntimeNodeNames(value, pieceLabel) {
  const names = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const normalized = [...new Set(names.map((entry) => String(entry || '').trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error(
      `Advanced/Blender Goon outfit piece "${pieceLabel}" must define at least one runtime node name.`
    );
  }
  return normalized;
}

function normalizeOptionalStringList(value) {
  const names = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  return [...new Set(names.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function parseGuidedOutfitData(manifest) {
  const outfit = manifest.outfit;
  if (outfit === undefined) {
    return {
      pieces: [],
      presets: []
    };
  }

  if (!outfit || typeof outfit !== 'object' || Array.isArray(outfit)) {
    throw new Error('Advanced/Blender Goon manifest outfit must be a JSON object when provided.');
  }

  const rawPieces = Array.isArray(outfit.pieces) ? outfit.pieces : [];
  const rawPresets = Array.isArray(outfit.presets) ? outfit.presets : [];
  const pieces = [];
  const seenPieceIds = new Set();

  rawPieces.forEach((piece, index) => {
    if (!piece || typeof piece !== 'object' || Array.isArray(piece)) {
      throw new Error('Advanced/Blender Goon manifest outfit.pieces entries must be JSON objects.');
    }

    const label = typeof piece.label === 'string' ? piece.label.trim() : '';
    if (!label) {
      throw new Error('Advanced/Blender Goon outfit pieces must include a non-empty label.');
    }

    const id = slugifyGuidedOutfitId(piece.id || label, 'piece', index);
    if (seenPieceIds.has(id)) {
      throw new Error(`Advanced/Blender Goon outfit piece id "${id}" is duplicated.`);
    }
    seenPieceIds.add(id);

    const materialNames = normalizeOptionalStringList(piece.materialNames);
    const concealRegions = normalizeOptionalStringList(piece.concealRegions);

    pieces.push({
      id,
      label,
      runtimeNodeNames: normalizeGuidedRuntimeNodeNames(piece.runtimeNodeNames, label),
      ...(typeof piece.category === 'string' && piece.category.trim()
        ? { category: piece.category.trim() }
        : {}),
      ...(typeof piece.defaultOn === 'boolean' ? { defaultOn: piece.defaultOn } : {}),
      ...(materialNames.length > 0 ? { materialNames } : {}),
      ...(concealRegions.length > 0 ? { concealRegions } : {})
    });
  });

  const presets = [];
  const seenPresetIds = new Set();
  const pieceIds = new Set(pieces.map((piece) => piece.id));

  rawPresets.forEach((preset, index) => {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
      throw new Error('Advanced/Blender Goon manifest outfit.presets entries must be JSON objects.');
    }

    const name = typeof preset.name === 'string' ? preset.name.trim() : '';
    if (!name) {
      throw new Error('Advanced/Blender Goon outfit presets must include a non-empty name.');
    }

    const id = slugifyGuidedOutfitId(preset.id || name, 'preset', index);
    if (seenPresetIds.has(id)) {
      throw new Error(`Advanced/Blender Goon outfit preset id "${id}" is duplicated.`);
    }
    seenPresetIds.add(id);

    const piecesOn = Array.isArray(preset.piecesOn)
      ? [...new Set(preset.piecesOn.map((entry) => String(entry || '').trim()).filter(Boolean))]
      : [];
    const piecesOff = Array.isArray(preset.piecesOff)
      ? [...new Set(preset.piecesOff.map((entry) => String(entry || '').trim()).filter(Boolean))]
      : [];

    for (const pieceId of [...piecesOn, ...piecesOff]) {
      if (!pieceIds.has(pieceId)) {
        throw new Error(
          `Advanced/Blender Goon outfit preset "${name}" references missing outfit piece id "${pieceId}".`
        );
      }
    }

    presets.push({
      id,
      name,
      ...(piecesOn.length > 0 ? { piecesOn } : {}),
      ...(piecesOff.length > 0 ? { piecesOff } : {})
    });
  });

  return { pieces, presets };
}

function parseGuidedGoonManifest(text) {
  const manifest = parseManifestObject(text, 'Advanced/Blender Goon');
  const { summary } = parseManifestSummary(manifest, 'Advanced/Blender Goon');
  const outfit = parseGuidedOutfitData(manifest);

  return {
    manifest,
    summary: {
      ...summary,
      outfitPieceCount: outfit.pieces.length,
      outfitPresetCount: outfit.presets.length
    },
    outfit
  };
}

/**
 * Process, optimize, and store a file locally.
 * @param {Object} file - Multer file object
 * @param {Object} compressionSettings - User's compression preferences
 * @param {Object} uploadSettings - Local upload/tunnel metadata
 * @returns {Object} File data with URL and metadata
 */
async function processAndStoreFile(file, compressionSettings = {}, uploadSettings = {}) {
  validateGenericUploadFile(file);
  uploadSettings = normalizeLocalUploadSettings(uploadSettings);

  const timestamp = Date.now();
  const uploadType = file.mimetype.startsWith('image/') ? 'images' : 
                    file.mimetype.startsWith('video/') ? 'videos' : 'documents';
  const originalName = file.originalname || 'upload';
  const fallbackBase =
    uploadType === 'images' ? 'image' : uploadType === 'videos' ? 'video' : 'document';
  const safeFilename = buildSafeUploadFilename(originalName, fallbackBase);
  
  let processedBuffer = file.buffer;
  let base64Content = null;
  let processedForAI = null;
  let textContent = null;
  
  // Process images: resize if needed
  if (file.mimetype.startsWith('image/')) {
    try {
      const metadata = await sharp(file.buffer).metadata();
      
      logger.info('[Image Upload] Original image metadata loaded');
      
      // Check if compression is enabled (default true)
      const compressionEnabled = compressionSettings.compress_images !== false;
      
      if (!compressionEnabled) {
        logger.info('[Image Upload] Compression disabled by user settings');
        base64Content = file.buffer.toString('base64');
        processedForAI = `data:${file.mimetype};base64,${base64Content}`;
      } else {
        // Get user's max image size preference (default 1024)
        const maxSize = compressionSettings.max_image_size === 'none' ? 
          null : parseInt(compressionSettings.max_image_size || '1024');
        
        // Always resize based on user's preference
        const needsResize = maxSize && (metadata.width > maxSize || metadata.height > maxSize);
        const needsCompression = file.size > 100000; // 100KB = ~33k tokens
        const isPNG = metadata.format === 'png';
        
        // Check if user wants to force JPEG conversion (default true) - moved outside if block
        const forceJpeg = compressionSettings.force_jpeg !== false;
        
        if (needsResize || needsCompression || isPNG) {
        logger.info('[Image Upload] Processing image');
        
        // Build the sharp pipeline
        let pipeline = sharp(file.buffer);
        
        // Resize if needed
        if (needsResize && maxSize) {
          pipeline = pipeline.resize(maxSize, maxSize, { 
            fit: 'inside',
            withoutEnlargement: true 
          });
        }
        const hasTransparency = metadata.channels === 4 && metadata.format === 'png';
        
        // Use user's compression quality preference (default 40)
        let quality = compressionSettings.compression_quality || 40;
        
        if (forceJpeg || (!isPNG && !hasTransparency)) {
          // Force JPEG conversion or already JPEG/non-transparent
          if (isPNG) {
            logger.info('[Image Upload] Converting PNG to JPEG');
          }
          logger.info('[Image Upload] Using JPEG output');
          
          pipeline = pipeline
            .flatten({ background: { r: 255, g: 255, b: 255 } }) // White background for transparency
            .jpeg({ quality });
        } else if (isPNG) {
          // User disabled force_jpeg and it's a PNG - keep as PNG but optimize
          logger.info('[Image Upload] Keeping as PNG');
          logger.info('[Image Upload] Using PNG compression level 9');
          
          pipeline = pipeline
            .png({ 
              compressionLevel: 9, // Max compression (0-9)
              adaptiveFiltering: true, // Better compression
              palette: file.size > 200000 // Use palette for large PNGs
            });
        } else {
          // Other formats - convert to JPEG
          logger.info('[Image Upload] Using JPEG output');
          
          pipeline = pipeline
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg({ quality });
        }
        
        processedBuffer = await pipeline.toBuffer();
        
        logger.info('[Image Upload] Image processing complete');
        } else {
          logger.info('[Image Upload] No processing needed - image already optimized');
        }
        
        base64Content = processedBuffer.toString('base64');
        // Determine the final mimetype based on what we output
        const finalMimeType = (!forceJpeg && isPNG) ? 'image/png' : 'image/jpeg';
        processedForAI = `data:${finalMimeType};base64,${base64Content}`;
      }
    } catch (error) {
      writeErrorLog(logger, 'Error processing image', error);
      throw error;
    }
  }
  
  const looksText = file.mimetype.includes('text/') || 
      file.mimetype.includes('application/json') ||
      file.mimetype.includes('application/javascript') ||
      originalName.endsWith('.md') ||
      originalName.endsWith('.txt') ||
      originalName.endsWith('.js') ||
      originalName.endsWith('.ts') ||
      originalName.endsWith('.jsx') ||
      originalName.endsWith('.tsx') ||
      originalName.endsWith('.css') ||
      originalName.endsWith('.html') ||
      originalName.endsWith('.xml') ||
      originalName.endsWith('.yaml') ||
      originalName.endsWith('.yml') ||
      originalName.endsWith('.json')

  // Process text documents - NO base64 encoding for text!
  if (looksText) {
    try {
      textContent = file.buffer.toString('utf-8');
      processedForAI = textContent;
      // Don't base64 encode text files - it wastes tokens!
      base64Content = null;
    } catch (error) {
      writeErrorLog(logger, 'Error processing text file', error);
    }
  }
  
  // For binary files (not text, not images), store base64
  if (!base64Content && !textContent) {
    base64Content = file.buffer.toString('base64');
  }
  
  // Prepare metadata for upload
  const strategyConfigInput =
    uploadSettings.strategyConfig && typeof uploadSettings.strategyConfig === 'object'
      ? uploadSettings.strategyConfig
      : {};
  const ttlCandidate = Number(
    strategyConfigInput.ttlSeconds ?? uploadSettings.artifact_ttl_seconds ?? 0
  );
  const artifactTtlSeconds =
    Number.isFinite(ttlCandidate) && ttlCandidate > 0 ? Math.floor(ttlCandidate) : 0;
  const artifactSource =
    typeof uploadSettings.artifact_source === 'string' ? uploadSettings.artifact_source : null;
  const ephemeralUpload =
    uploadSettings.ephemeral === true || artifactTtlSeconds > 0 || artifactSource === 'agent_browser_screenshot';

  const metadata = {
    originalName,
    mimetype: file.mimetype,
    size: processedBuffer.length,
    originalSize: file.size,
    uploadType: uploadType,
    uploadedAt: new Date().toISOString(),
    // Clip uploads always persist locally; this field is retained in upload metadata.
    storageMode: uploadSettings.storage_mode || 'local',
    artifactTtlSeconds,
    artifactSource,
    ephemeralUpload
  };
  
  // User clips are stored locally; model-facing URL/base64 transport is selected at send time.
  const strategy = 'local';

  // Determine host and HTTPS settings
  let hostConfig, httpsConfig;

  const tunnelConfig = normalizeTunnelConfig(uploadSettings.tunnel_url, uploadSettings.use_https);
  if (tunnelConfig?.host) {
    // User has configured a tunnel URL - use it!
    hostConfig = tunnelConfig.host;
    httpsConfig = tunnelConfig.useHttps !== undefined ? tunnelConfig.useHttps : true; // Default true for tunnels
    logger.info('[Upload] Using configured tunnel URL');
  } else {
    // No tunnel - use auto-detected host or fallback to localhost
    hostConfig = uploadSettings.host || 'localhost:5600';
    httpsConfig = uploadSettings.useHttps || false;
  }

  const strategyConfig = {
    useHttps: httpsConfig,
    host: hostConfig,
    ...strategyConfigInput // Strategy-specific config (e.g., Imgur client ID)
  };

  logger.info('[Upload] Using local clip storage');
  uploadManager.setStrategy(strategy, strategyConfig);
  
  // Upload using local storage.
  const uploadResult = await uploadManager.upload(
    processedBuffer,
    safeFilename,
    metadata
  );

	  logger.debug('[Upload] File stored locally');
  const fallbackUsed = Boolean(uploadResult.fallback);
  const fallbackReason = uploadResult.fallbackReason || null;
  const fallbackFrom = uploadResult.originalStrategy || null;

  // Local storage returns a Redis key. The fallback shape is defensive only.
  const fallbackStoredFilename = `${timestamp}_${safeFilename}`;
  const redisKey = uploadResult.redisKey || `external:${uploadResult.strategy}:${fallbackStoredFilename}`;

  // Persisted clip storage is always local.
  const storageMode = uploadResult.storageMode || uploadSettings.storage_mode || 'local';

  // Clip records do not carry image base64. The upload record/file is the source
  // for send-time data URLs, and tunnel URLs are resolved from tunnelPath.
  const shouldIncludeBase64 = !uploadResult.skipBase64;

  if (!shouldIncludeBase64) {
    logger.info('[Upload] Skipping clip-level base64 - send-time payloads resolve from local upload storage');
  }

  return {
    redisKey,
    filename: uploadResult.filename || fallbackStoredFilename,
    originalName,
    mimetype: file.mimetype,
    size: processedBuffer.length,
    base64: shouldIncludeBase64 ? base64Content : null,
    textContent: textContent,
    processedForAI: shouldIncludeBase64 ? processedForAI : null,
    category: uploadType,
    url: uploadResult.url,
    displayUrl: uploadResult.displayUrl || uploadResult.url, // Display URL for frontend
    externalUrl: uploadResult.externalUrl || null,
    tunnelPath: uploadResult.tunnelPath || null,
    uploadStrategy: uploadResult.strategy,
    requestedStrategy: strategy,
    fallback: fallbackUsed,
    fallbackReason,
    fallbackFrom,
    storageMode: storageMode
  };
}

// Multi-file upload endpoint
router.post('/upload', upload.array('files', 10), async (req, res) => {
  const uploadStartTime = Date.now();
  logger.debug('[TIMING] Multi-file upload started');
  
  try {
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

	    logger.debug('[Upload] Multiple files received');
    
    // Extract session ID from request (could be in body, query, or headers)
    const sessionId = readFirstStringField(
      req.body.sessionId,
      req.query.sessionId,
      req.headers['x-session-id']
    );
    logger.debug('[Upload] Session ID presence checked');
    
    // Extract compression settings
    let compressionSettings = {};
    try {
      const rawCompressionSettings = readFirstStringField(req.body.compressionSettings);
      if (rawCompressionSettings) {
        compressionSettings = JSON.parse(rawCompressionSettings);
        logger.info('[Image Upload] User compression settings received');
      }
    } catch (e) {
      logger.warn('Failed to parse compression settings, using defaults');
    }
    
    // Extract upload settings
    let uploadSettings = {};
    try {
      const rawUploadSettings = readFirstStringField(req.body.uploadSettings);
      if (rawUploadSettings) {
        uploadSettings = JSON.parse(rawUploadSettings);
        logger.info('[Upload] Received clip upload settings from frontend:', {
          hasTunnelUrl: Boolean(uploadSettings.tunnel_url)
        });
      } else {
        logger.info('[Upload] No upload settings received, using local storage');
      }
    } catch (e) {
      logger.warn('[Upload] Failed to parse upload settings, using local storage');
      uploadSettings = { strategy: 'local' };
    }
    
    // Add protocol detection for local strategy
    uploadSettings.useHttps = req.secure || req.get('x-forwarded-proto') === 'https';
    uploadSettings.host = req.get('host');

    // Get userId from request (clips are per-user, not per-session)
    const userId = requireUploadUserId(req, res);
    if (!userId) return;

    const processedFiles = [];
    let fileIndex = 0;
    
    for (const file of uploadedFiles) {
      const fileStartTime = Date.now();
	      logger.debug('[TIMING] Processing uploaded file');

      // Process, optimize, and store locally.
      const fileData = await processAndStoreFile(file, compressionSettings, uploadSettings);
      
      logger.info('[Upload] FileData returned from processAndStoreFile:', {
        hasUrl: Boolean(fileData.url),
        hasTunnelPath: Boolean(fileData.tunnelPath),
        hasClipLevelBase64: Boolean(fileData.base64)
      });
      
      // Generate clip ID using the batshitzipService for consistency
      // Pass userId instead of sessionId since clips are per-user
      const clipData = batshitzipService.generateFileZip(fileData, 'USER', userId, fileIndex);
      const {
        clipFormatted,
        clipRecord,
        externalTokens,
        localTokens,
        storageMode
      } = buildPersistedClipUpload({
        file,
        fileData,
        clipData,
        userId,
        compressionSettings
      });
	      logger.info('[Upload] Storage mode determined');
      
      fileIndex++;
      
      logger.info('[Upload] Storing clip with:', {
        hasClipId: Boolean(clipData.id),
        storageMode: clipRecord.storageMode,
        hasExternalUrl: Boolean(clipRecord.externalUrl),
        hasTunnelPath: Boolean(clipRecord.tunnelPath),
        hasLocalUrl: Boolean(clipRecord.localUrl),
        hasLocalBase64: Boolean(clipRecord.localBase64)
      });
      
      // Store clip in Redis
      await redisService.setClip(userId, clipData.id, clipRecord);
      logger.debug('[Upload] Stored clip in Redis');

      processedFiles.push({
        ...fileData,
        clipId: clipData.id,
        externalTokens,
        localTokens,
        clipFormatted: clipFormatted,
        clipData: {
          id: clipData.id,
          formatted: clipFormatted,
          tokens: localTokens,
          externalTokens,
          localTokens,
          storageMode: storageMode,
          description: clipData.description
        }
      });
      
      const fileEndTime = Date.now();
      logger.debug('[TIMING] Uploaded file processed');
    }

    const uploadEndTime = Date.now();
    logger.debug('[TIMING] Total upload processing complete');

    res.json({
      success: true,
      files: processedFiles
    });
  } catch (error) {
	    logger.error('Multi-file upload error');
    sendUploadError(res, 'Multi-file upload failed', error);
  }
});

// Single file upload endpoint (legacy)
router.post('/upload/single', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Extract session ID
    const sessionId = readFirstStringField(
      req.body.sessionId,
      req.query.sessionId,
      req.headers['x-session-id']
    );
    
    // Extract compression settings
    let compressionSettings = {};
    try {
      const rawCompressionSettings = readFirstStringField(req.body.compressionSettings);
      if (rawCompressionSettings) {
        compressionSettings = JSON.parse(rawCompressionSettings);
      }
    } catch (e) {
      logger.warn('Failed to parse compression settings, using defaults');
    }
    
    // Extract upload settings
    let uploadSettings = {};
    try {
      const rawUploadSettings = readFirstStringField(req.body.uploadSettings);
      if (rawUploadSettings) {
        uploadSettings = JSON.parse(rawUploadSettings);
      }
    } catch (e) {
      uploadSettings = { strategy: 'local' };
    }
    
    // Add protocol detection for local strategy
    uploadSettings.useHttps = req.secure || req.get('x-forwarded-proto') === 'https';
    uploadSettings.host = req.get('host');

    // Get userId from request (clips are per-user, not per-session)
    const userId = requireUploadUserId(req, res);
    if (!userId) return;

    const fileData = await processAndStoreFile(req.file, compressionSettings, uploadSettings);

    const artifactSource =
      typeof uploadSettings.artifact_source === 'string'
        ? uploadSettings.artifact_source
        : null;
    const skipClipPersistence =
      uploadSettings.skip_clip_persistence === true ||
      artifactSource === 'agent_browser_screenshot';

    if (skipClipPersistence) {
      const responseTokenEstimate = req.file.mimetype.startsWith('image/')
        ? 765
        : (fileData.base64 ? Math.ceil(fileData.base64.length / 4) : null);

      return res.json({
        success: true,
        file: {
          ...fileData,
          artifactSource,
          persistedAs: 'upload',
          clipPersistenceSkipped: true,
          tokenEstimate: responseTokenEstimate
        }
      });
    }
    
    // User uploads are always clip objects (never XML zips).
    const clipData = batshitzipService.generateFileZip(fileData, 'USER', userId, 0);
    const {
      clipFormatted,
      clipRecord,
      externalTokens,
      localTokens,
      storageMode
    } = buildPersistedClipUpload({
      file: req.file,
      fileData,
      clipData,
      userId,
      compressionSettings
    });

    await redisService.setClip(userId, clipData.id, clipRecord);

    const responseTokenEstimate = localTokens;
    
    res.json({
      success: true,
      file: {
        ...fileData,
        clipFormatted: clipFormatted,
        clipId: clipData.id,
        externalTokens,
        localTokens,
        clipData: {
          id: clipData.id,
          formatted: clipFormatted,
          tokens: responseTokenEstimate,
          externalTokens,
          localTokens,
          storageMode: storageMode,
          description: clipData.description
        }
      }
    });
  } catch (error) {
	    logger.error('Upload error');
    sendUploadError(res, 'File upload failed', error);
  }
});

// Avatar upload endpoint.
router.post('/upload/avatar', avatarUploadRateLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const avatarSignature = detectUploadSignature(req.file.buffer);
    if (!['png', 'jpeg', 'gif', 'webp'].includes(avatarSignature)) {
      return res.status(400).json({ error: 'Avatar must be an image' });
    }

    // Get entity type and ID from request body
    const { entityType, entityId, oldAvatarUrl } = req.body;
    
    // Process avatar: always resize to 256x256
    const avatarBuffer = await sharp(req.file.buffer)
      .resize(256, 256, { 
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 90 })
      .toBuffer();
    
    const timestamp = Date.now();
    
    // Organize avatars by entity type
    let avatarFilename;
    let redisKey;
    
    if (entityType && entityId) {
      // New organized structure: type_id_timestamp.jpg
      avatarFilename = `${entityType}_${entityId}_${timestamp}.jpg`;
      redisKey = `upload:avatars:${entityType}:${avatarFilename}`;
    } else {
      // Fallback to old structure for backward compatibility
      avatarFilename = `avatar_${timestamp}.jpg`;
      redisKey = `upload:avatars:${avatarFilename}`;
    }
    
    // Delete old avatar if provided
    if (oldAvatarUrl) {
      try {
        // Extract filename from old URL
        const oldFilename = oldAvatarUrl.split('/').pop();
        
        // Try both old and new key patterns
        const oldKeys = Array.from(new Set([
          `upload:avatars:${oldFilename}`,
          ...(entityType ? [`upload:avatars:${entityType}:${oldFilename}`] : []),
          `upload:avatars:user:${oldFilename}`,
          `upload:avatars:agent:${oldFilename}`,
          `upload:avatars:subagent:${oldFilename}`,
          `upload:avatars:group:${oldFilename}`
        ]));
        
        for (const key of oldKeys) {
          const exists = await redisService.client.exists(key);
          if (exists) {
            await deleteStoredUploadRecord(key);
	            logger.info('Deleted old avatar');
            break;
          }
        }
      } catch (cleanupError) {
        writeErrorLog(logger, 'Failed to delete old avatar', cleanupError);
        // Continue with upload even if cleanup fails
      }
    }
    
    await storeFilesystemUploadAsset(req, {
      uploadType: 'avatars',
      originalName: req.file.originalname,
      filename: avatarFilename,
      mimetype: 'image/jpeg',
      buffer: avatarBuffer,
      redisKey,
      metadata: {
        entityType: entityType || 'unknown',
        entityId: entityId || 'unknown'
      }
    });
    
    // Construct the public URL - maintaining same URL structure for compatibility
    const avatarUrl = `${req.protocol}://${req.get('host')}/uploads/avatars/${avatarFilename}`;

    res.json({
      success: true,
      url: avatarUrl,
      filename: avatarFilename
    });
  } catch (error) {
    writeErrorLog(logger, 'Avatar upload error', error);
    sendUploadError(res, 'Avatar upload failed', error);
  }
});

router.delete('/upload/asset', async (req, res) => {
  try {
    const uploadType = req.body?.uploadType;
    const filename = req.body?.filename;
    if (!uploadType || !filename) {
      return res.status(400).json({ error: 'uploadType and filename are required' });
    }

    const result = await deleteStoredUploadAsset(uploadType, filename);
    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    writeErrorLog(logger, 'Upload asset delete error', error);
    return res.status(500).json({
      error: 'Upload asset delete failed',
      details: error.message
    });
  }
});

// Goon (VRM) upload endpoint
router.post('/upload/goon', goonVrmUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    await validateGoonBinaryUpload(req.file, {
      expectedExt: '.vrm',
      expectedSignature: 'glb',
      label: 'Goon VRM'
    });

    const originalName = req.file.originalname || 'goon.vrm';
    const ext = path.extname(originalName).toLowerCase();

    if (ext !== '.vrm') {
      return res.status(400).json({ error: 'Goon files must be VRM 1.0 (.vrm)' });
    }

    const safeBase = sanitizeFilenameSegment(path.basename(originalName, ext), 'goon').slice(0, 80) || 'goon';

    const timestamp = Date.now();
    const filename = `${timestamp}_${safeBase}.vrm`;

    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goons',
      originalName,
      filename,
      mimetype: req.file.mimetype || 'application/octet-stream',
      sourceFile: req.file,
      size: req.file.size
    });

    return res.json({
      success: true,
      file
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon upload error', error);
    sendUploadError(res, 'Goon upload failed', error);
  } finally {
    await cleanupTempUploadFile(req.file);
  }
});

router.post('/upload/goon-custom-package', goonCustomPackageUpload.single('file'), async (req, res) => {
  const newlyStoredAssets = [];
  let extractedMembers = [];
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'custom_goon.zip';
    const ext = path.extname(originalName).toLowerCase();

    if (ext !== '.zip' && ext !== '.bgoon') {
      return res.status(400).json({
        error: 'Custom Goon packages must be .zip or .bgoon archives'
      });
    }

    const archivePath = resolveMulterDiskUploadPath(req.file);
    if (!archivePath || (await detectUploadSignatureFromFile(req.file)) !== 'zip') {
      throw uploadValidationError('Custom Goon package content is not a zip archive.');
    }
    const extraction = await inspectAndExtractRecipeArchive({
      archivePath,
      outputDir: goonDiskUploadTempDir,
      maxArchiveBytes: GOON_CUSTOM_PACKAGE_MAX_FILE_SIZE,
      maxModelBytes: GOON_CUSTOM_PACKAGE_MAX_FILE_SIZE - GOON_MANIFEST_MAX_BYTES,
      maxManifestBytes: GOON_MANIFEST_MAX_BYTES,
      maxTotalUncompressedBytes: GOON_CUSTOM_PACKAGE_MAX_FILE_SIZE,
      maxExpansionRatio: 20
    });
    extractedMembers = extraction.members;
    const { summary } = parseCustomGoonManifest(extraction.manifestText);
    const manifestMember = extraction.members.find((member) => member.role === 'manifest');
    const modelMember = extraction.members.find((member) => member.role === 'model');
    if (!manifestMember || !modelMember) {
      throw uploadValidationError('Custom Goon package extraction did not return both required members.');
    }

    const packageFilename = `${extraction.archive.sha256}.bgoon`;
    const modelFilename = `${modelMember.sha256}.glb`;
    const manifestFilename = `${manifestMember.sha256}.json`;

    const storeImmutableAsset = async ({
      uploadType,
      filename,
      expectedSha256,
      expectedBytes,
      originalAssetName,
      mimetype,
      operation
    }) => {
      const redisKey = `upload:${uploadType}:${filename}`;
      const existing = await redisService.get(redisKey);
      if (existing) {
        const existingPath = resolveFileBackedPayloadPath(existing);
        if (
          existing.storage !== 'filesystem' ||
          existing.sha256 !== expectedSha256 ||
          existing.size !== expectedBytes ||
          !existingPath
        ) {
          throw new Error(`Immutable Recipe asset metadata collision at ${redisKey}.`);
        }
        const storedHash = await hashFile(existingPath).catch(() => null);
        if (
          !storedHash ||
          storedHash.sha256 !== expectedSha256 ||
          storedHash.bytes !== expectedBytes
        ) {
          throw new Error(`Immutable Recipe asset bytes are corrupt at ${redisKey}.`);
        }
        return {
          filename,
          originalName: existing.originalName || originalAssetName,
          url: buildRedisUploadUrl(req, uploadType, filename),
          mimetype: existing.mimetype || mimetype,
          size: existing.size,
          uploadedAt: existing.uploadedAt,
          redisKey,
          storage: 'filesystem',
          sha256: existing.sha256
        };
      }
      const stored = await operation();
      newlyStoredAssets.push({ uploadType, filename });
      return stored;
    };

    const packageFile = await storeImmutableAsset({
      uploadType: 'goon_custom_packages',
      filename: packageFilename,
      expectedSha256: extraction.archive.sha256,
      expectedBytes: extraction.archive.bytes,
      originalAssetName: originalName,
      mimetype: req.file.mimetype || 'application/zip',
      operation: () =>
      storeFilesystemUploadAsset(req, {
      uploadType: 'goon_custom_packages',
      originalName,
      filename: packageFilename,
      mimetype: req.file.mimetype || 'application/zip',
      sourceFile: req.file,
      size: extraction.archive.bytes,
      metadata: {
        sha256: extraction.archive.sha256,
        immutable: true,
        recipeArchiveRole: 'archive'
      }
    })
    });

    const modelFile = await storeImmutableAsset({
      uploadType: 'goon_custom_models',
      filename: modelFilename,
      expectedSha256: modelMember.sha256,
      expectedBytes: modelMember.bytes,
      originalAssetName: 'avatar.glb',
      mimetype: 'model/gltf-binary',
      operation: () =>
      storeFilesystemUploadAsset(req, {
      uploadType: 'goon_custom_models',
      originalName: 'avatar.glb',
      filename: modelFilename,
      mimetype: 'model/gltf-binary',
      sourceFile: {
        filename: path.basename(modelMember.tempPath),
        originalname: 'avatar.glb'
      },
      size: modelMember.bytes,
      metadata: {
        sha256: modelMember.sha256,
        immutable: true,
        recipeArchiveRole: 'model'
      }
    })
    });

    const manifestFile = await storeImmutableAsset({
      uploadType: 'goon_custom_manifests',
      filename: manifestFilename,
      expectedSha256: manifestMember.sha256,
      expectedBytes: manifestMember.bytes,
      originalAssetName: 'avatar.json',
      mimetype: 'application/json',
      operation: () =>
      storeFilesystemUploadAsset(req, {
      uploadType: 'goon_custom_manifests',
      originalName: 'avatar.json',
      filename: manifestFilename,
      mimetype: 'application/json',
      sourceFile: {
        filename: path.basename(manifestMember.tempPath),
        originalname: 'avatar.json'
      },
      size: manifestMember.bytes,
      metadata: {
        sha256: manifestMember.sha256,
        immutable: true,
        recipeArchiveRole: 'manifest',
        manifestSummary: summary
      }
    })
    });

    return res.json({
      success: true,
      files: {
        package: packageFile,
        model: modelFile,
        manifest: manifestFile
      },
      manifestData: summary,
      archiveExtraction: {
        contract: extraction.contract,
        extractor: extraction.extractor,
        archive: {
          ref: `/uploads/goon_custom_packages/${packageFilename}`,
          sha256: extraction.archive.sha256,
          bytes: extraction.archive.bytes
        },
        entryCount: extraction.entryCount,
        totalUncompressedBytes: extraction.totalUncompressedBytes,
        members: [
          {
            role: 'manifest',
            path: manifestMember.path,
            sha256: manifestMember.sha256,
            bytes: manifestMember.bytes,
            extracted: {
              ref: `/uploads/goon_custom_manifests/${manifestFilename}`,
              sha256: manifestMember.sha256,
              bytes: manifestMember.bytes
            }
          },
          {
            role: 'model',
            path: modelMember.path,
            sha256: modelMember.sha256,
            bytes: modelMember.bytes,
            extracted: {
              ref: `/uploads/goon_custom_models/${modelFilename}`,
              sha256: modelMember.sha256,
              bytes: modelMember.bytes
            }
          }
        ]
      }
    });
  } catch (error) {
    for (const asset of newlyStoredAssets.reverse()) {
      await deleteStoredUploadAsset(asset.uploadType, asset.filename).catch((cleanupError) => {
        writeErrorLog(logger, 'Recipe package partial-write cleanup failed', cleanupError);
      });
    }
    writeErrorLog(logger, 'Custom Goon package upload error', error);
    sendUploadError(res, 'Custom Goon package upload failed', error);
  } finally {
    await cleanupTempUploadFile(req.file);
    await Promise.all(
      extractedMembers.map((member) => fs.rm(member.tempPath, { force: true }).catch(() => {}))
    );
  }
});

router.post('/upload/goon-guided-package', goonGuidedPackageUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'guided_goon.zip';
    const ext = path.extname(originalName).toLowerCase();

    if (ext !== '.zip' && ext !== '.bgoon') {
      return res.status(400).json({
        error: 'Advanced/Blender Goon packages must be .zip or .bgoon archives'
      });
    }

    let archiveEntries;
    const archiveBuffer = await readUploadedFileBuffer(req.file);
    try {
      if (detectUploadSignature(archiveBuffer) !== 'zip') {
        throw uploadValidationError('Advanced/Blender Goon package content is not a zip archive.');
      }
      archiveEntries = readConstrainedGoonArchiveEntries(archiveBuffer, {
        laneLabel: 'Advanced/Blender Goon',
        allowedBasenames: ['avatar.json', 'avatar.vrm', 'avatar.glb'],
        maxUncompressedBytes: GOON_GUIDED_PACKAGE_MAX_FILE_SIZE
      });
    } catch (error) {
      if (error?.statusCode) throw error;
      return res
        .status(400)
        .json({ error: 'Advanced/Blender Goon package could not be opened as a zip archive' });
    }

    const manifestEntries = archiveEntries.filter(
      ([entryName]) => getArchiveEntryBasename(entryName).toLowerCase() === 'avatar.json'
    );
    const vrmEntries = archiveEntries.filter(
      ([entryName]) => getArchiveEntryBasename(entryName).toLowerCase() === 'avatar.vrm'
    );
    const glbEntries = archiveEntries.filter(
      ([entryName]) => getArchiveEntryBasename(entryName).toLowerCase() === 'avatar.glb'
    );

    if (manifestEntries.length !== 1 || vrmEntries.length !== 1) {
      const glbHint =
        glbEntries.length > 0
          ? ' `avatar.glb` packages belong to the Advanced/GLB lane; Advanced/Blender packages must include `avatar.vrm`.'
          : '';
      return res.status(400).json({
        error: `Advanced/Blender Goon package must contain exactly one avatar.vrm and one avatar.json.${glbHint}`
      });
    }

    const [manifestEntryName, manifestBytes] = manifestEntries[0];
    const manifestText = strFromU8(manifestBytes);
    const { summary, outfit } = parseGuidedGoonManifest(manifestText);

    const [, vrmBytes] = vrmEntries[0];
    const safeBase =
      sanitizeFilenameSegment(path.basename(originalName, ext), 'guided_goon').slice(0, 80) ||
      'guided_goon';
    const timestamp = Date.now();

    const packageFilename = `${timestamp}_${safeBase}${ext}`;
    const vrmFilename = `${timestamp}_${safeBase}_avatar.vrm`;
    const manifestFilename = `${timestamp}_${safeBase}_avatar.json`;
    const vrmBuffer = Buffer.from(vrmBytes);
    if (detectUploadSignature(vrmBuffer) !== 'glb') {
      throw uploadValidationError('Advanced/Blender Goon avatar.vrm content does not match a GLB/VRM signature.');
    }

    const packageFile = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_guided_packages',
      originalName,
      filename: packageFilename,
      mimetype: req.file.mimetype || 'application/zip',
      sourceFile: req.file,
      size: req.file.size
    });

    const vrmFile = await storeFilesystemUploadAsset(req, {
      uploadType: 'goons',
      originalName: 'avatar.vrm',
      filename: vrmFilename,
      mimetype: 'model/vrm',
      buffer: vrmBuffer,
      size: vrmBuffer.length
    });

    const manifestFile = await storeRedisUploadAsset(req, {
      uploadType: 'goon_guided_manifests',
      originalName: getArchiveEntryBasename(manifestEntryName) || 'avatar.json',
      filename: manifestFilename,
      mimetype: 'application/json',
      textContent: manifestText,
      size: Buffer.byteLength(manifestText)
    });

    return res.json({
      success: true,
      files: {
        package: packageFile,
        vrm: vrmFile,
        manifest: manifestFile
      },
      manifestData: {
        summary,
        outfitPieces: outfit.pieces,
        outfitPresets: outfit.presets
      }
    });
  } catch (error) {
    writeErrorLog(logger, 'Advanced/Blender Goon package upload error', error);
    sendUploadError(res, 'Advanced/Blender Goon package upload failed', error);
  } finally {
    await cleanupTempUploadFile(req.file);
  }
});

// Goon animation upload endpoint (GLB/GLTF)
router.post('/upload/goon-animation', goonAnimationUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'goon_animation.glb';
    const ext = path.extname(originalName).toLowerCase();

    if (ext !== '.glb' && ext !== '.gltf' && ext !== '.vrma') {
      return res.status(400).json({ error: 'Goon animation files must be .glb, .gltf, or .vrma' });
    }

    const safeBase =
      sanitizeFilenameSegment(path.basename(originalName, ext), 'goon_animation').slice(0, 80) ||
      'goon_animation';

    const timestamp = Date.now();
    const filename = `${timestamp}_${safeBase}${ext}`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_animations',
      originalName,
      filename,
      mimetype: req.file.mimetype || 'application/octet-stream',
      buffer: req.file.buffer,
      size: req.file.size
    });

    return res.json({
      success: true,
      file
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon animation upload error', error);
    res.status(500).json({ error: 'Goon animation upload failed', details: error.message });
  }
});

router.post('/upload/goon-animation-preview', goonAnimationPreviewUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'motion_preview.webm';
    const sourceExt = path.extname(originalName).toLowerCase();
    if (sourceExt !== '.webm' && sourceExt !== '.mp4' && sourceExt !== '.mov') {
      return res.status(400).json({ error: 'Animation preview files must be .webm, .mp4, or .mov' });
    }

    const transcoded = await transcodeGoonAnimationPreviewToMp4(req.file);
    const safeBase =
      sanitizeFilenameSegment(
        path.basename(originalName, sourceExt || path.extname(originalName)),
        'motion_preview'
      ).slice(0, 80) || 'motion_preview';

    const timestamp = Date.now();
    const filename = `${timestamp}_${safeBase}.mp4`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_animation_previews',
      originalName,
      filename,
      mimetype: transcoded.mimetype,
      buffer: transcoded.buffer,
      size: transcoded.size
    });

    return res.json({
      success: true,
      file
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon animation preview upload error', error);
    res.status(500).json({ error: 'Goon animation preview upload failed', details: error.message });
  }
});

// First-party facial artwork upload. Batshit prepares canonical sRGB/RGBA8
// bytes against the package-owned safe mask, then validates and stores those
// exact prepared bytes. Template dimensions remain strict: no resampling.
router.post('/upload/goon-facial-artwork', goonFacialArtworkUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const originalName = req.file.originalname || 'facial_artwork.png';
    if (path.extname(originalName).toLowerCase() !== '.png' || req.file.mimetype !== 'image/png') {
      throw uploadValidationError('Facial artwork must be a PNG image.');
    }
    const prepared = await prepareFacialArtworkUpload({
      buffer: req.file.buffer,
      role: req.body?.role,
      definitionSha256: req.body?.definitionSha256,
      templateId: req.body?.templateId,
      templateVersion: req.body?.templateVersion,
      orientation: req.body?.orientation,
      guideSha256: req.body?.guideSha256,
      maskSha256: req.body?.maskSha256,
      provenance: req.body?.provenance
    });
    const validation = prepared.artwork;
    const safeBase =
      sanitizeFilenameSegment(path.basename(originalName, '.png'), validation.role).slice(0, 80) ||
      validation.role;
    const filename = `${Date.now()}_${crypto.randomUUID()}_${safeBase}.png`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_facial_artwork',
      originalName,
      filename,
      mimetype: 'image/png',
      buffer: prepared.buffer,
      size: prepared.buffer.length,
      metadata: { facialArtwork: validation }
    });
    return res.json({ success: true, file, artwork: validation, preparation: prepared.preparation });
  } catch (error) {
    writeErrorLog(logger, 'Goon facial artwork upload error', error);
    sendUploadError(res, 'Facial artwork upload failed', error);
  }
});

router.post('/upload/goon-lip-artwork', goonFacialArtworkUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const originalName = req.file.originalname || 'lip_artwork.png';
    if (path.extname(originalName).toLowerCase() !== '.png' || req.file.mimetype !== 'image/png') {
      throw uploadValidationError('Lip Artwork must be a PNG image.');
    }
    const prepared = await prepareLipArtworkUpload({
      buffer: req.file.buffer,
      definitionSha256: req.body?.definitionSha256,
      templateId: req.body?.templateId,
      templateVersion: req.body?.templateVersion,
      guideSha256: req.body?.guideSha256,
      maskSha256: req.body?.maskSha256,
      baseLipReferenceMaskSha256: req.body?.baseLipReferenceMaskSha256,
      width: Number(req.body?.width),
      height: Number(req.body?.height),
      provenance: req.body?.provenance
    });
    const safeBase =
      sanitizeFilenameSegment(path.basename(originalName, '.png'), 'lip_artwork').slice(0, 80) ||
      'lip_artwork';
    const filename = `${Date.now()}_${crypto.randomUUID()}_${safeBase}.png`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_facial_artwork',
      originalName,
      filename,
      mimetype: 'image/png',
      buffer: prepared.buffer,
      size: prepared.buffer.length,
      metadata: { lipArtwork: prepared.artwork }
    });
    return res.json({
      success: true,
      file,
      artwork: prepared.artwork,
      preparation: prepared.preparation
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon Lip Artwork upload error', error);
    sendUploadError(res, 'Lip Artwork upload failed', error);
  }
});

router.post('/upload/goon-nail-artwork', goonFacialArtworkUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const originalName = req.file.originalname || 'nail_artwork.png';
    if (path.extname(originalName).toLowerCase() !== '.png' || req.file.mimetype !== 'image/png') {
      throw uploadValidationError('Nail Artwork must be a PNG image.');
    }
    const prepared = await prepareNailArtworkUpload({
      buffer: req.file.buffer,
      family: req.body?.family,
      definitionSha256: req.body?.definitionSha256,
      templateId: req.body?.templateId,
      templateVersion: req.body?.templateVersion,
      guideSha256: req.body?.guideSha256,
      slotMaskSha256: req.body?.slotMaskSha256,
      baseArtworkSha256: req.body?.baseArtworkSha256,
      width: Number(req.body?.width),
      height: Number(req.body?.height),
      provenance: req.body?.provenance
    });
    const safeBase =
      sanitizeFilenameSegment(
        path.basename(originalName, '.png'),
        `${prepared.artwork.family}_nails`
      ).slice(0, 80) || `${prepared.artwork.family}_nails`;
    const filename = `${Date.now()}_${crypto.randomUUID()}_${safeBase}.png`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_nail_artwork',
      originalName,
      filename,
      mimetype: 'image/png',
      buffer: prepared.buffer,
      size: prepared.buffer.length,
      metadata: { nailArtwork: prepared.artwork }
    });
    return res.json({
      success: true,
      file,
      artwork: prepared.artwork,
      preparation: prepared.preparation
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon Nail Artwork upload error', error);
    sendUploadError(res, 'Nail Artwork upload failed', error);
  }
});

router.post('/upload/goon-skin-surface-artwork', goonSkinSurfaceArtworkUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const map = typeof req.body?.map === 'string' ? req.body.map : '';
    const originalName = req.file.originalname || `${map || 'skin_surface'}_artwork.png`;
    if (path.extname(originalName).toLowerCase() !== '.png' || req.file.mimetype !== 'image/png') {
      throw uploadValidationError('Skin Surface Artwork must be a PNG image.');
    }
    const prepared = await prepareSkinSurfaceArtworkUpload({
      buffer: req.file.buffer,
      map,
      definitionSha256: req.body?.definitionSha256,
      provenance: req.body?.provenance
    });
    const safeBase =
      sanitizeFilenameSegment(path.basename(originalName, '.png'), `${map || 'skin_surface'}_artwork`).slice(0, 80) ||
      `${map || 'skin_surface'}_artwork`;
    const filename = `${Date.now()}_${crypto.randomUUID()}_${safeBase}.png`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_skin_artwork',
      originalName,
      filename,
      mimetype: 'image/png',
      buffer: prepared.buffer,
      size: prepared.buffer.length,
      metadata: { skinSurfaceArtwork: prepared.artwork }
    });
    return res.json({
      success: true,
      file,
      artwork: prepared.artwork,
      preparation: prepared.preparation
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon Skin Surface Artwork upload error', error);
    sendUploadError(res, 'Skin Surface Artwork upload failed', error);
  }
});

// Goon closet texture upload endpoint (PNG only, no resizing)
router.post('/upload/goon-closet', goonImageUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'closet_texture.png';
    const ext = path.extname(originalName).toLowerCase();

    if (ext !== '.png' || req.file.mimetype !== 'image/png') {
      return res.status(400).json({ error: 'Closet textures must be PNG images.' });
    }

    const safeBase =
      sanitizeFilenameSegment(path.basename(originalName, ext), 'closet_texture').slice(0, 80) ||
      'closet_texture';

    const timestamp = Date.now();
    const filename = `${timestamp}_${safeBase}.png`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_closet',
      originalName,
      filename,
      mimetype: req.file.mimetype || 'image/png',
      buffer: req.file.buffer,
      size: req.file.size
    });

    return res.json({
      success: true,
      file
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon closet upload error', error);
    res.status(500).json({ error: 'Closet upload failed', details: error.message });
  }
});

router.delete('/upload/goon-closet', async (req, res) => {
  try {
    const filename = req.body?.filename;
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    await deleteStoredUploadAsset('goon_closet', filename);
    return res.json({ success: true });
  } catch (error) {
    writeErrorLog(logger, 'Goon closet delete error', error);
    res.status(500).json({ error: 'Closet delete failed', details: error.message });
  }
});

// Goon scene upload endpoint (PNG/JPG only, no resizing)
router.post('/upload/goon-scene', goonSceneUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'scene.png';
    const ext = path.extname(originalName).toLowerCase();
    const isPng = ext === '.png' && req.file.mimetype === 'image/png';
    const isJpeg =
      (ext === '.jpg' || ext === '.jpeg') &&
      (req.file.mimetype === 'image/jpeg' || req.file.mimetype === 'image/jpg');

    if (!isPng && !isJpeg) {
      return res.status(400).json({ error: 'Scene images must be PNG or JPG.' });
    }

    const safeBase = sanitizeFilenameSegment(path.basename(originalName, ext), 'scene').slice(0, 80) || 'scene';

    const timestamp = Date.now();
    const normalizedExt = ext === '.jpeg' ? '.jpg' : ext;
    const filename = `${timestamp}_${safeBase}${normalizedExt}`;
    const thumbnailFilename = `${timestamp}_${safeBase}_thumb.jpg`;
    const thumbnailBuffer = await buildGoonSceneThumbnail(req.file.buffer);
    const sceneFile = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_scenes',
      originalName,
      filename,
      mimetype: req.file.mimetype || (isPng ? 'image/png' : 'image/jpeg'),
      buffer: req.file.buffer,
      size: req.file.size
    });
    const thumbnailFile = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_scene_thumbs',
      originalName: `${safeBase}_thumb.jpg`,
      filename: thumbnailFilename,
      mimetype: 'image/jpeg',
      buffer: thumbnailBuffer,
      size: thumbnailBuffer.length
    });

    return res.json({
      success: true,
      file: {
        filename,
        originalName,
        url: sceneFile.url,
        thumbnailUrl: thumbnailFile.url,
        mimetype: req.file.mimetype || (isPng ? 'image/png' : 'image/jpeg'),
        size: req.file.size,
        uploadedAt: sceneFile.uploadedAt,
        redisKey: sceneFile.redisKey
      }
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon scene upload error', error);
    res.status(500).json({ error: 'Scene upload failed', details: error.message });
  }
});

router.delete('/upload/goon-scene', async (req, res) => {
  try {
    const filename = req.body?.filename;
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const thumbnailFilename = `${base}_thumb.jpg`;
    await deleteStoredUploadAsset('goon_scenes', filename);
    await deleteStoredUploadAsset('goon_scene_thumbs', thumbnailFilename);
    return res.json({ success: true });
  } catch (error) {
    writeErrorLog(logger, 'Goon scene delete error', error);
    res.status(500).json({ error: 'Scene delete failed', details: error.message });
  }
});

// Goon room shell upload endpoint (GLB/GLTF only)
router.post('/upload/goon-room-shell', goonSceneModelUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'room_shell.glb';
    const ext = path.extname(originalName).toLowerCase();
    const isGlb = ext === '.glb';
    const isGltf = ext === '.gltf';

    if (!isGlb && !isGltf) {
      return res.status(400).json({ error: 'Room shells must be GLB or GLTF.' });
    }

    const safeBase =
      sanitizeFilenameSegment(path.basename(originalName, ext), 'room_shell').slice(0, 80) ||
      'room_shell';

    const timestamp = Date.now();
    const filename = `${timestamp}_${safeBase}${ext}`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_room_shells',
      originalName,
      filename,
      mimetype: req.file.mimetype || (isGlb ? 'model/gltf-binary' : 'model/gltf+json'),
      buffer: req.file.buffer,
      size: req.file.size
    });

    return res.json({
      success: true,
      file
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon room shell upload error', error);
    res.status(500).json({ error: 'Room shell upload failed', details: error.message });
  }
});

router.delete('/upload/goon-room-shell', async (req, res) => {
  try {
    const filename = req.body?.filename;
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    await deleteStoredUploadAsset('goon_room_shells', filename);
    return res.json({ success: true });
  } catch (error) {
    writeErrorLog(logger, 'Goon room shell delete error', error);
    res.status(500).json({ error: 'Room shell delete failed', details: error.message });
  }
});

// Goon room texture upload endpoint (PNG/JPG only)
router.post('/upload/goon-room-texture', goonSceneUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'room_texture.png';
    const ext = path.extname(originalName).toLowerCase();
    const isPng = ext === '.png';
    const isJpg = ext === '.jpg' || ext === '.jpeg';

    if (!isPng && !isJpg) {
      return res.status(400).json({ error: 'Room textures must be PNG or JPG.' });
    }

    const kind = req.body?.kind;
    const safeBase =
      sanitizeFilenameSegment(path.basename(originalName, ext), 'room_texture').slice(0, 80) ||
      'room_texture';

    const timestamp = Date.now();
    const normalizedExt = ext === '.jpeg' ? '.jpg' : ext;
    const filename = `${timestamp}_${safeBase}${normalizedExt}`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_room_textures',
      originalName,
      filename,
      mimetype: req.file.mimetype || (isPng ? 'image/png' : 'image/jpeg'),
      buffer: req.file.buffer,
      size: req.file.size,
      metadata: { kind }
    });

    return res.json({
      success: true,
      file: { ...file, kind }
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon room texture upload error', error);
    res.status(500).json({ error: 'Room texture upload failed', details: error.message });
  }
});

router.delete('/upload/goon-room-texture', async (req, res) => {
  try {
    const filename = req.body?.filename;
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    await deleteStoredUploadAsset('goon_room_textures', filename);
    return res.json({ success: true });
  } catch (error) {
    writeErrorLog(logger, 'Goon room texture delete error', error);
    res.status(500).json({ error: 'Room texture delete failed', details: error.message });
  }
});

// Goon scene props upload endpoint (GLB/GLTF only)
router.post('/upload/goon-scene-prop', goonSceneModelUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = req.file.originalname || 'prop.glb';
    const ext = path.extname(originalName).toLowerCase();
    const isGlb = ext === '.glb';
    const isGltf = ext === '.gltf';

    if (!isGlb && !isGltf) {
      return res.status(400).json({ error: 'Props must be GLB or GLTF.' });
    }

    const safeBase = sanitizeFilenameSegment(path.basename(originalName, ext), 'prop').slice(0, 80) || 'prop';

    const timestamp = Date.now();
    const filename = `${timestamp}_${safeBase}${ext}`;
    const file = await storeFilesystemUploadAsset(req, {
      uploadType: 'goon_scene_props',
      originalName,
      filename,
      mimetype: req.file.mimetype || (isGlb ? 'model/gltf-binary' : 'model/gltf+json'),
      buffer: req.file.buffer,
      size: req.file.size
    });

    return res.json({
      success: true,
      file
    });
  } catch (error) {
    writeErrorLog(logger, 'Goon scene prop upload error', error);
    res.status(500).json({ error: 'Prop upload failed', details: error.message });
  }
});

router.delete('/upload/goon-scene-prop', async (req, res) => {
  try {
    const filename = req.body?.filename;
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    await deleteStoredUploadAsset('goon_scene_props', filename);
    return res.json({ success: true });
  } catch (error) {
    writeErrorLog(logger, 'Goon scene prop delete error', error);
    res.status(500).json({ error: 'Prop delete failed', details: error.message });
  }
});

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      const limitBytes = getUploadLimitForPath(req.path);
      const limitText = limitBytes ? ` ${formatUploadLimit(limitBytes)} or smaller.` : '';
      return res.status(413).json({ error: `File too large.${limitText}` });
    }

    return res.status(400).json({ error: error.message || 'Upload failed' });
  }

  return next(error);
});

module.exports = router;
module.exports.buildSafeUploadFilename = buildSafeUploadFilename;
module.exports.parseGuidedOutfitData = parseGuidedOutfitData;
module.exports.parseCustomGoonManifest = parseCustomGoonManifest;
module.exports.detectUploadSignature = detectUploadSignature;
module.exports.validateGenericUploadFile = validateGenericUploadFile;
module.exports.readConstrainedGoonArchiveEntries = readConstrainedGoonArchiveEntries;
module.exports.getUploadLimitForPath = getUploadLimitForPath;
module.exports.GOON_CORE_IMPORT_MAX_FILE_SIZE = GOON_CORE_IMPORT_MAX_FILE_SIZE;
