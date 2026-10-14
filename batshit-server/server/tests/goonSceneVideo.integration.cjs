// Run with node --test tests/goonSceneVideo.integration.cjs. Requires FFmpeg/FFprobe.
// FFMPEG_PATH/FFPROBE_PATH select the binaries under test. Fixture encoding uses
// BATSHIT_TEST_FFMPEG_ENCODER_PATH (or host ffmpeg) so decoder-only packages work.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');
const { inspectGoonSceneVideo } = require('../src/services/goonSceneVideo');
const run = promisify(execFile);
const directory = fs.mkdtemp(path.join(os.tmpdir(), 'batshit-panorama-test-'));
after(async () => fs.rm(await directory, { recursive: true, force: true }));

async function fixture(name, { size = '256x128', fps = 24, duration = 1 } = {}) {
  const file = path.join(await directory, name);
  await run(process.env.BATSHIT_TEST_FFMPEG_ENCODER_PATH || 'ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=purple:s=${size}:r=${fps}`,
    '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file
  ]);
  return file;
}

test('valid panorama retains media metadata and produces a real JPEG thumbnail', async () => {
  const result = await inspectGoonSceneVideo(await fixture('valid.mp4'), '.mp4');
  assert.equal(result.mimeType, 'video/mp4');
  assert.equal(result.width, 256);
  assert.equal(result.height, 128);
  assert.equal(result.fps, 24);
  assert.equal(result.duration, 1);
  assert.equal(result.codec, 'h264');
  assert.equal(result.thumbnailBuffer.subarray(0, 2).toString('hex'), 'ffd8');
});

for (const codec of ['av1', 'hevc']) {
  test(`${codec} panorama decodes with the selected upload binaries`, async () => {
    const file = path.join(__dirname, 'fixtures', 'goon-scene-video', `${codec}-256x128.mp4`);
    const result = await inspectGoonSceneVideo(file, '.mp4');
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.codec, codec);
    assert.equal(result.width, 256);
    assert.equal(result.height, 128);
    assert.equal(result.fps, 2);
    assert.equal(result.duration, 1);
    const thumbnail = await sharp(result.thumbnailBuffer).metadata();
    assert.equal(thumbnail.format, 'jpeg');
    assert.equal(thumbnail.width, 480);
    assert.equal(thumbnail.height, 240);
  });
}

test('rejects a valid video with the wrong projection', async () => {
  await assert.rejects(inspectGoonSceneVideo(await fixture('flat.mp4', { size: '256x144' }), '.mp4'),
    (error) => error.statusCode === 400 && /2:1/.test(error.message));
});

test('rejects excessive duration and frame rate before thumbnail generation', async () => {
  await assert.rejects(inspectGoonSceneVideo(await fixture('long.mp4', { fps: 1, duration: 121 }), '.mp4'),
    (error) => error.statusCode === 400 && /two minutes/.test(error.message));
  await assert.rejects(inspectGoonSceneVideo(await fixture('fast.mp4', { fps: 61 }), '.mp4'),
    (error) => error.statusCode === 400 && /60 frames/.test(error.message));
});

test('rejects a spoofed extension and a truncated container', async () => {
  const spoof = path.join(await directory, 'spoof.mp4');
  await fs.writeFile(spoof, 'this is not a video');
  await assert.rejects(inspectGoonSceneVideo(spoof, '.mp4'),
    (error) => error.statusCode === 400 && /content must match/.test(error.message));
  const truncated = path.join(await directory, 'truncated.mp4');
  const valid = await fs.readFile(await fixture('complete.mp4'));
  await fs.writeFile(truncated, valid.subarray(0, 16));
  await assert.rejects(inspectGoonSceneVideo(truncated, '.mp4'),
    (error) => error.statusCode === 400 && /could not be inspected/.test(error.message));
});
