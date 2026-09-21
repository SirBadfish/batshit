import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DAV1D_PROOF_FILES = [
  'share/dav1d/COPYING',
  'share/dav1d/SOURCE.txt',
  'share/dav1d/CHECKSUMS.txt'
];

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  };
}

function output(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

// Shared by preparation, cache reuse, and the final signed package audit. Merely
// listing the native AV1 decoder does not prove decoding on Macs without AV1 hardware.
export async function inspectFfmpegRuntimeCapabilities(runtimeRoot, {
  allowGpl = false,
  requireDav1dProof = true,
  runCaptured = capture
} = {}) {
  const issues = [];
  const ffmpeg = join(runtimeRoot, 'bin', 'ffmpeg');
  const version = runCaptured(ffmpeg, ['-hide_banner', '-version']);
  const versionOutput = output(version);
  const configLine = versionOutput.split(/\r?\n/).find((line) => line.startsWith('configuration:')) || '';
  if (!version.ok || !/^ffmpeg version\s/m.test(versionOutput)) {
    issues.push('Managed FFmpeg must run successfully and report its version.');
  }
  if (!configLine) issues.push('Managed FFmpeg must report its configure flags.');
  if (configLine.includes('--enable-nonfree')) {
    issues.push('Managed FFmpeg must not use --enable-nonfree.');
  }
  const gplEnabled = configLine.includes('--enable-gpl');
  if (gplEnabled && !allowGpl) {
    issues.push('Managed FFmpeg must not use --enable-gpl without explicit release acceptance.');
  }

  const encoders = runCaptured(ffmpeg, ['-hide_banner', '-encoders']);
  if (!encoders.ok || !/^\s*V\S*\s+h264_videotoolbox(?:\s|$)/m.test(output(encoders))) {
    issues.push('Managed FFmpeg must include the h264_videotoolbox encoder for MP4 previews.');
  }
  const decoders = runCaptured(ffmpeg, ['-hide_banner', '-decoders']);
  if (!decoders.ok || !/^\s*V\S*\s+libdav1d(?:\s|$)/m.test(output(decoders))) {
    issues.push('Managed FFmpeg must include the libdav1d software AV1 decoder for panorama video uploads. Rebuild the managed FFmpeg runtime.');
  }
  const probe = runCaptured(join(runtimeRoot, 'bin', 'ffprobe'), ['-version']);
  if (!probe.ok || !/^ffprobe version\s/m.test(output(probe))) {
    issues.push('Managed FFmpeg must include a working bin/ffprobe for panorama video uploads.');
  }
  if (requireDav1dProof) {
    for (const relative of DAV1D_PROOF_FILES) {
      const text = await readFile(join(runtimeRoot, relative), 'utf8').catch(() => '');
      if (!text.trim()) issues.push(`Managed FFmpeg is missing the bundled dav1d notice or provenance: ${relative}`);
    }
  }
  return { ok: issues.length === 0, issues, versionOutput, configLine, gplEnabled };
}
