import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { DAV1D_PROOF_FILES, inspectFfmpegRuntimeCapabilities } from './ffmpeg-runtime-capabilities.mjs';

const VERSION = 'ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers\nconfiguration: --disable-autodetect --enable-libdav1d --enable-videotoolbox';
const DECODERS = 'Decoders:\n V....D av1                  Alliance for Open Media AV1\n V..... libdav1d            dav1d AV1 decoder by VideoLAN (codec av1)\n';
const ENCODERS = 'Encoders:\n V....D h264_videotoolbox   VideoToolbox H.264 Encoder (codec h264)\n';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'batshit-ffmpeg-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of DAV1D_PROOF_FILES) {
    await mkdir(join(root, relative, '..'), { recursive: true });
    await writeFile(join(root, relative), 'Retained dav1d distribution evidence\n');
  }
  const responses = {
    'ffmpeg -hide_banner -version': VERSION,
    'ffmpeg -hide_banner -decoders': DECODERS,
    'ffmpeg -hide_banner -encoders': ENCODERS,
    'ffprobe -version': 'ffprobe version 8.1.2 Copyright (c) 2007-2026 the FFmpeg developers\n',
    ...overrides
  };
  const runCaptured = (command, args) => {
    assert.equal(command, join(root, 'bin', basename(command)), 'probe must use this runtime, never host PATH');
    const response = responses[`${basename(command)} ${args.join(' ')}`];
    assert.notEqual(response, undefined, 'unexpected binary probe');
    return typeof response === 'string'
      ? { ok: true, stdout: response, stderr: '' }
      : response;
  };
  return { root, runCaptured };
}

test('accepts software AV1, native H.264 encoding, working FFprobe, and retained dav1d evidence', async (t) => {
  const { root, runCaptured } = await fixture(t);
  const result = await inspectFfmpegRuntimeCapabilities(root, { runCaptured });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.gplEnabled, false);
  assert.match(result.configLine, /--enable-libdav1d/);
});

test('rejects hardware-only AV1 even when configure flags mention dav1d', async (t) => {
  const { root, runCaptured } = await fixture(t, {
    'ffmpeg -hide_banner -decoders': ' V....D av1 Alliance for Open Media AV1\n V..... av1_videotoolbox AV1 VideoToolbox decoder\n'
  });
  const result = await inspectFfmpegRuntimeCapabilities(root, { runCaptured });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /libdav1d software AV1 decoder/);
});

test('failed decoder command cannot pass from a plausible output listing', async (t) => {
  const { root, runCaptured } = await fixture(t, {
    'ffmpeg -hide_banner -decoders': { ok: false, stdout: DECODERS, stderr: 'dyld failure' }
  });
  const result = await inspectFfmpegRuntimeCapabilities(root, { runCaptured });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /libdav1d software AV1 decoder/);
});

test('rejects a decoder description mentioning libdav1d without an actual libdav1d entry', async (t) => {
  const { root, runCaptured } = await fixture(t, {
    'ffmpeg -hide_banner -decoders': ' V..... av1 Native decoder (libdav1d unavailable)\n'
  });
  assert.equal((await inspectFfmpegRuntimeCapabilities(root, { runCaptured })).ok, false);
});

test('requires native H.264 encoding and an identifiable working FFprobe', async (t) => {
  const { root, runCaptured } = await fixture(t, {
    'ffmpeg -hide_banner -encoders': ' V....D libx264 libx264 H.264 encoder\n',
    'ffprobe -version': { ok: false, stdout: '', stderr: 'not found' }
  });
  const result = await inspectFfmpegRuntimeCapabilities(root, { runCaptured });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 2);
  assert.match(result.issues.join('\n'), /h264_videotoolbox/);
  assert.match(result.issues.join('\n'), /working bin\/ffprobe/);
});

test('GPL requires explicit release acceptance while nonfree is always rejected', async (t) => {
  const { root, runCaptured } = await fixture(t, {
    'ffmpeg -hide_banner -version': `${VERSION} --enable-gpl`
  });
  assert.equal((await inspectFfmpegRuntimeCapabilities(root, { runCaptured })).ok, false);
  assert.equal((await inspectFfmpegRuntimeCapabilities(root, { runCaptured, allowGpl: true })).ok, true);
  const nonfree = await fixture(t, { 'ffmpeg -hide_banner -version': `${VERSION} --enable-nonfree` });
  const rejected = await inspectFfmpegRuntimeCapabilities(nonfree.root, { runCaptured: nonfree.runCaptured, allowGpl: true });
  assert.equal(rejected.ok, false);
  assert.match(rejected.issues.join('\n'), /--enable-nonfree/);
});

test('empty or missing dav1d notice and provenance fail the distribution check', async (t) => {
  const { root, runCaptured } = await fixture(t);
  await rm(join(root, 'share/dav1d/COPYING'));
  await writeFile(join(root, 'share/dav1d/SOURCE.txt'), ' \n');
  const result = await inspectFfmpegRuntimeCapabilities(root, { runCaptured });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 2);
  assert.match(result.issues.join('\n'), /share\/dav1d\/COPYING/);
  assert.match(result.issues.join('\n'), /share\/dav1d\/SOURCE.txt/);
  assert.equal((await inspectFfmpegRuntimeCapabilities(root, { runCaptured, requireDav1dProof: false })).ok, true);
});

test('missing FFmpeg version or configuration cannot pass capability checks', async (t) => {
  const { root, runCaptured } = await fixture(t, {
    'ffmpeg -hide_banner -version': { ok: false, stdout: '', stderr: 'exec failed' }
  });
  const result = await inspectFfmpegRuntimeCapabilities(root, { runCaptured });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /report its version/);
  assert.match(result.issues.join('\n'), /configure flags/);
});
