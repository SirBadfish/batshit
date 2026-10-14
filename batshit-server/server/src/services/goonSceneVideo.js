const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** Inspect only a server-owned upload path; never pass client URLs to FFmpeg. */
async function inspectGoonSceneVideo(filePath, extension) {
  const handle = await fs.open(filePath, 'r');
  const header = Buffer.alloc(16);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const isMp4 = extension === '.mp4' && header.toString('ascii', 4, 8) === 'ftyp';
  const isWebm = extension === '.webm' && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!isMp4 && !isWebm) throw invalid('Panorama video content must match its MP4 or WebM extension.');
  const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm'];
  let result;
  try {
    result = await run(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', ...inputOptions, '-show_streams', '-show_format', '-of', 'json', filePath
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Panorama video upload requires FFprobe and FFmpeg on the Batshit server.');
    throw invalid('The panorama video could not be inspected. Export a valid MP4 or WebM.');
  }
  const info = JSON.parse(result.stdout);
  const videos = (info.streams || []).filter((stream) => stream.codec_type === 'video');
  if (videos.length !== 1) throw invalid('Panorama videos must contain one video stream.');
  const video = videos[0];
  const width = Number(video.width);
  const height = Number(video.height);
  const duration = Number(info.format?.duration || video.duration);
  const [numerator, denominator = '1'] = String(video.avg_frame_rate).split('/');
  const fps = Number(numerator) / Number(denominator);
  if (!Number.isFinite(width / height) || width < 2 || height < 1 || Math.abs(width / height - 2) > .02) {
    throw invalid('Panorama videos must be 2:1 equirectangular videos, such as 4096 × 2048.');
  }
  if (width > 8192 || height > 4096) throw invalid('Panorama videos may be up to 8192 × 4096.');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw invalid('Panorama videos must be no longer than two minutes.');
  if (!Number.isFinite(fps) || fps <= 0 || fps > 60) throw invalid('Panorama videos must use 60 frames per second or less.');
  const codecs = isMp4 ? ['h264', 'hevc', 'av1'] : ['vp8', 'vp9', 'av1'];
  if (!codecs.includes(video.codec_name)) throw invalid('Use H.264, HEVC or AV1 in MP4, or VP8, VP9 or AV1 in WebM.');
  let thumbnail;
  try {
    thumbnail = await run(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-nostdin', '-v', 'error', ...inputOptions,
      '-threads', '2', '-i', filePath, '-map', '0:v:0', '-frames:v', '1', '-an',
      '-vf', 'scale=480:240', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'
    ], { encoding: 'buffer', timeout: 45_000, maxBuffer: 5 * 1024 * 1024 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Panorama video upload requires FFmpeg on the Batshit server.');
    throw invalid('The panorama video could not be decoded. Try a different export.');
  }
  return { thumbnailBuffer: thumbnail.stdout, mimeType: isMp4 ? 'video/mp4' : 'video/webm', width, height, duration, fps, codec: video.codec_name };
}

module.exports = { inspectGoonSceneVideo };
