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

### Redis

- Purpose: stores chats, agents, settings, zips, clips, prompts, sessions, and RedisJSON-backed records.
- Distribution: Redis Open Source 8. Redis 8 merged Redis Stack into the main distribution and bundles the JSON and Search modules; Redis Stack is a retired product and is no longer used.
- Mac app baseline: `redis-oss-8.10.1-arm64.zip` from <https://packages.redis.io/homebrew/>, pinned by SHA-256 and verified at asset-preparation time. Only `rejson.so` and `redisearch.so` are bundled.
- Docker baseline: `redis:8.10.1-alpine`, pinned by multi-architecture manifest digest in `compose.yaml`.
- Official source: <https://github.com/redis/redis/releases/tag/8.10.1>
- License: tri-licensed under your choice of the Redis Source Available License v2 (RSALv2), the Server Side Public License v1 (SSPLv1), or the GNU Affero General Public License v3 (AGPLv3).
- Redis license overview: <https://redis.io/legal/licenses/>
- Packaging rule: the Redis 8 macOS archive ships no license files, so include Redis's own `LICENSE.txt` (which carries all three licenses) and `REDISCONTRIBUTIONS.txt` from the matching release tag, do not remove Redis licensing/copyright notices, and keep Redis bound to Batshit's private loopback port/data directory.

### OpenSSL

- Purpose: provides the TLS/cryptography dynamic libraries required by the packaged Redis binaries and modules.
- Launch target: OpenSSL 3.5 LTS for macOS arm64.
- Official source and license: <https://www.openssl.org/source/> and <https://www.openssl.org/source/license-openssl-3.0.txt>.
- Packaging rule: build from the checksum-verified official source archive, include `LICENSE.txt`, the source/checksum record, and both package-owned dynamic libraries with loader-relative references. Redis must never resolve OpenSSL through Homebrew or another build-machine path.

### FFmpeg

- Purpose: media and Goon preview transcoding in `batshit-server`.
- Official source and legal guidance: <https://ffmpeg.org/download.html> and <https://ffmpeg.org/legal.html>
- Packaging rule: do not bundle an arbitrary FFmpeg binary. Any packaged FFmpeg runtime must include the exact license files, source-code offer/source reference, checksum record, and build configuration used for that binary.
- Mac app encoder rule: the packaged Mac runtime is expected to use FFmpeg's `h264_videotoolbox` encoder for MP4 previews, so the Mac bundle does not need a bundled `libx264`/GPL dependency for that path.
- Release guardrail: package preparation rejects FFmpeg builds configured with `--enable-nonfree`, and rejects `--enable-gpl` unless release owners explicitly accept GPL obligations for that release package.
- Portability guardrail: the Mac build disables dependency autodetection and X11/XCB integration, targets macOS 14, and must resolve every non-system dynamic library from inside the app bundle.

### Apple Container

- Purpose: default Mac app command sandbox backend on supported Macs.
- Official project: <https://github.com/apple/container>
- Install path: user-approved signed installer package from Apple's release page.
- Packaging rule: Batshit does not silently install Apple Container. Runtime Doctor may detect it, start the system service when installed, and link users to the official installer flow.

## Docker Runtime

Docker installs use Compose-managed images instead of Mac app vendor binaries for the core app runtime. The Docker Redis baseline is the digest-pinned Redis 8 image declared in `compose.yaml`; Docker image notices and upstream image metadata remain part of the Docker distribution boundary.
