# Third-Party Notices

Batshit is licensed under AGPL-3.0-only. This file tracks launch-relevant third-party runtime notices for packaged self-hosted builds.

This notice is informational and is not legal advice. Final release packaging must keep the exact license files, source references, and checksum/signature records for any third-party binaries included in the distributed artifact.

## Packaged Mac App Runtimes

The Mac app can include app-owned runtime binaries under `Batshit.app/Contents/Resources/runtime/vendor/`. Packaging hooks only copy these runtimes when explicit distribution folders are provided.

### Node.js

- Purpose: runs the packaged SvelteKit app/server payload.
- Launch target: Node.js 24 for macOS arm64.
- Official distribution: <https://nodejs.org/dist/latest-v24.x/>
- License: Node.js `LICENSE` from the official distribution.
- Packaging rule: include the unmodified official `LICENSE` file with the copied Node distribution and verify the official `SHASUMS256.txt` entry before release packaging.

### Redis Stack / Redis

- Purpose: stores chats, agents, settings, zips, clips, prompts, sessions, and RedisJSON-backed records.
- Launch target: Redis Stack 7.4.x for the alpha Mac app; Redis 8 migration is intentionally deferred.
- Current Docker baseline: `redis/redis-stack-server:7.4.0-v8`.
- Official Redis Stack release: <https://github.com/redis-stack/redis-stack/releases/tag/v7.4.0-v8>
- Redis license overview: <https://redis.io/legal/licenses/>
- Packaging rule: include the Redis Stack package's `RSALv2.txt` and `SSPLv1.txt` notices, do not remove Redis licensing/copyright notices, and keep Redis bound to Batshit's private loopback port/data directory.

### FFmpeg

- Purpose: media and Goon preview transcoding in `batshit-server`.
- Official source and legal guidance: <https://ffmpeg.org/download.html> and <https://ffmpeg.org/legal.html>
- Packaging rule: do not bundle an arbitrary FFmpeg binary. Any packaged FFmpeg runtime must include the exact license files, source-code offer/source reference, checksum record, and build configuration used for that binary.
- Mac app encoder rule: the packaged Mac runtime is expected to use FFmpeg's `h264_videotoolbox` encoder for MP4 previews, so the Mac bundle does not need a bundled `libx264`/GPL dependency for that path.
- Release guardrail: package preparation rejects FFmpeg builds configured with `--enable-nonfree`, and rejects `--enable-gpl` unless release owners explicitly accept GPL obligations for that release package.

### Apple Container

- Purpose: default Mac app command sandbox backend on supported Macs.
- Official project: <https://github.com/apple/container>
- Install path: user-approved signed installer package from Apple's release page.
- Packaging rule: Batshit does not silently install Apple Container. Runtime Doctor may detect it, start the system service when installed, and link users to the official installer flow.

## Docker Runtime

Docker installs use Compose-managed images instead of Mac app vendor binaries for the core app runtime. The Docker Redis baseline is the Redis Stack image declared in `compose.yaml`; Docker image notices and upstream image metadata remain part of the Docker distribution boundary.
