#!/usr/bin/env python3
"""Authenticated, cache-first HTTP bridge for NVIDIA Audio2Face-3D NIM v2.0."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator


SCHEMA_VERSION = "batshit-audio2face/v1"
BRIDGE_VERSION = "0.1.0"
OUTPUT_FPS = 30
BITS_PER_SAMPLE = 16
CHANNEL_COUNT = 1
DEFAULT_CHUNK_SECONDS = 1


class BridgeError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 500):
        super().__init__(message)
        self.code = code
        self.status = status


class CacheCorruptionError(BridgeError):
    def __init__(self, cache_key: str):
        super().__init__(
            "AUDIO2FACE_CACHE_CORRUPT",
            f"Audio2Face cache entry {cache_key} is corrupt. Remove that entry before retrying.",
            500,
        )


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required.")
    return value


def _positive_int_env(name: str, fallback: int, minimum: int = 1) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer.") from exc
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}.")
    return value


def _boolean_env(name: str, fallback: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return fallback
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean.")


HOST = os.environ.get("BATSHIT_AUDIO2FACE_BRIDGE_HOST", "0.0.0.0")
PORT = _positive_int_env("BATSHIT_AUDIO2FACE_BRIDGE_PORT", 8068)
AUTH_TOKEN = _required_env("BATSHIT_AUDIO2FACE_BRIDGE_TOKEN")
NIM_ENDPOINT = os.environ.get("BATSHIT_AUDIO2FACE_NIM_ENDPOINT", "host.docker.internal:52000").strip()
NIM_TLS = _boolean_env("BATSHIT_AUDIO2FACE_NIM_TLS")
NIM_ROOT_CERT = os.environ.get("BATSHIT_AUDIO2FACE_NIM_ROOT_CERT", "").strip()
NIM_CLIENT_CERT = os.environ.get("BATSHIT_AUDIO2FACE_NIM_CLIENT_CERT", "").strip()
NIM_CLIENT_KEY = os.environ.get("BATSHIT_AUDIO2FACE_NIM_CLIENT_KEY", "").strip()
NIM_TIMEOUT_SECONDS = _positive_int_env("BATSHIT_AUDIO2FACE_NIM_TIMEOUT_SECONDS", 180)
NIM_HEALTH_TIMEOUT_SECONDS = _positive_int_env("BATSHIT_AUDIO2FACE_NIM_HEALTH_TIMEOUT_SECONDS", 3)
MAX_AUDIO_BYTES = _positive_int_env("BATSHIT_AUDIO2FACE_MAX_AUDIO_BYTES", 67_108_864)
CACHE_DIR = Path(os.environ.get("BATSHIT_AUDIO2FACE_CACHE_DIR", "/cache")).resolve()
CACHE_MAX_BYTES = _positive_int_env("BATSHIT_AUDIO2FACE_CACHE_MAX_BYTES", 2_147_483_648)
CACHE_MAX_ENTRIES = _positive_int_env("BATSHIT_AUDIO2FACE_CACHE_MAX_ENTRIES", 2_000)
TONGUE_REQUESTED = _boolean_env("BATSHIT_AUDIO2FACE_TONGUE_ENABLED")


if not NIM_ENDPOINT or ":" not in NIM_ENDPOINT:
    raise RuntimeError("BATSHIT_AUDIO2FACE_NIM_ENDPOINT must be a host:port gRPC endpoint.")
if not NIM_TLS and any((NIM_ROOT_CERT, NIM_CLIENT_CERT, NIM_CLIENT_KEY)):
    raise RuntimeError("Audio2Face TLS certificate paths require BATSHIT_AUDIO2FACE_NIM_TLS=1.")
if NIM_TLS and bool(NIM_CLIENT_CERT) != bool(NIM_CLIENT_KEY):
    raise RuntimeError("Audio2Face mTLS requires both client certificate and client key paths.")


@dataclass(frozen=True)
class AudioRequest:
    pcm: bytes
    sample_rate: int

    @property
    def duration_ms(self) -> float:
        return len(self.pcm) / (BITS_PER_SAMPLE // 8) / self.sample_rate * 1000


class ResultCache:
    def __init__(self, root: Path, max_bytes: int, max_entries: int):
        self.root = root
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self._maintenance_lock = threading.Lock()
        self.root.mkdir(parents=True, exist_ok=True)

    def key_for(self, request: AudioRequest) -> str:
        config = json.dumps(
            {
                "schemaVersion": SCHEMA_VERSION,
                "bridgeVersion": BRIDGE_VERSION,
                "sampleRate": request.sample_rate,
                "nimEndpoint": NIM_ENDPOINT,
                "tongueRequested": TONGUE_REQUESTED,
                "clampedWeights": True,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        digest = hashlib.sha256()
        digest.update(len(config).to_bytes(8, "big"))
        digest.update(config)
        digest.update(request.pcm)
        return digest.hexdigest()

    def _path(self, cache_key: str) -> Path:
        return self.root / f"{cache_key}.json"

    def load(self, cache_key: str) -> dict[str, Any] | None:
        path = self._path(cache_key)
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if (
                not isinstance(payload, dict)
                or payload.get("schemaVersion") != SCHEMA_VERSION
                or payload.get("status") != "success"
                or payload.get("cacheKey") != cache_key
            ):
                raise ValueError("cache contract mismatch")
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise CacheCorruptionError(cache_key) from exc
        os.utime(path, None)
        payload["cacheHit"] = True
        return payload

    def store(self, cache_key: str, payload: dict[str, Any]) -> None:
        path = self._path(cache_key)
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        with tempfile.NamedTemporaryFile(dir=self.root, prefix=f".{cache_key}.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        self.prune(keep=path)

    def prune(self, keep: Path | None = None) -> None:
        with self._maintenance_lock:
            entries = []
            for path in self.root.glob("*.json"):
                try:
                    stat = path.stat()
                except OSError:
                    continue
                entries.append((stat.st_mtime_ns, stat.st_size, path))
            entries.sort(reverse=True)
            total = 0
            kept = 0
            for _, size, path in entries:
                must_keep = keep is not None and path == keep
                allowed = kept < self.max_entries and total + size <= self.max_bytes
                if must_keep or allowed:
                    kept += 1
                    total += size
                    continue
                path.unlink(missing_ok=True)


CACHE = ResultCache(CACHE_DIR, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES)
_KEY_LOCKS: dict[str, threading.Lock] = {}
_KEY_LOCKS_GUARD = threading.Lock()


def _lock_for(cache_key: str) -> threading.Lock:
    with _KEY_LOCKS_GUARD:
        return _KEY_LOCKS.setdefault(cache_key, threading.Lock())


def _release_lock(cache_key: str, lock: threading.Lock) -> None:
    with _KEY_LOCKS_GUARD:
        if not lock.locked() and _KEY_LOCKS.get(cache_key) is lock:
            _KEY_LOCKS.pop(cache_key, None)


def _read_file(path: str) -> bytes:
    try:
        return Path(path).read_bytes()
    except OSError as exc:
        raise RuntimeError(f"Unable to read Audio2Face TLS file {path}: {exc}") from exc


def _create_grpc_channel():
    import grpc

    options = [
        ("grpc.max_send_message_length", MAX_AUDIO_BYTES + 1_048_576),
        ("grpc.max_receive_message_length", 268_435_456),
    ]
    if not NIM_TLS:
        return grpc.insecure_channel(NIM_ENDPOINT, options=options)
    root = _read_file(NIM_ROOT_CERT) if NIM_ROOT_CERT else None
    certificate = _read_file(NIM_CLIENT_CERT) if NIM_CLIENT_CERT else None
    key = _read_file(NIM_CLIENT_KEY) if NIM_CLIENT_KEY else None
    credentials = grpc.ssl_channel_credentials(
        root_certificates=root,
        private_key=key,
        certificate_chain=certificate,
    )
    return grpc.secure_channel(NIM_ENDPOINT, credentials, options=options)


def probe_nim() -> tuple[bool, str | None]:
    import grpc
    from nvidia_ace.health_pb2 import HealthCheckRequest, HealthCheckResponse
    from nvidia_ace.health_pb2_grpc import HealthStub

    channel = _create_grpc_channel()
    try:
        response = HealthStub(channel).Check(
            HealthCheckRequest(),
            timeout=NIM_HEALTH_TIMEOUT_SECONDS,
        )
        if response.status == HealthCheckResponse.SERVING:
            return True, None
        return False, f"NVIDIA Audio2Face health status is {response.status}."
    except grpc.RpcError as exc:
        return False, f"NVIDIA Audio2Face gRPC health check failed: {exc.code().name}."
    finally:
        channel.close()


def _request_messages(request: AudioRequest) -> Iterator[Any]:
    from nvidia_ace.a2f.v1_pb2 import AudioWithEmotion, BlendShapeParameters
    from nvidia_ace.audio.v1_pb2 import AudioHeader
    from nvidia_ace.controller.v1_pb2 import AudioStream, AudioStreamHeader

    yield AudioStream(
        audio_stream_header=AudioStreamHeader(
            audio_header=AudioHeader(
                samples_per_second=request.sample_rate,
                bits_per_sample=BITS_PER_SAMPLE,
                channel_count=CHANNEL_COUNT,
                audio_format=AudioHeader.AUDIO_FORMAT_PCM,
            ),
            blendshape_params=BlendShapeParameters(enable_clamping_bs_weight=True),
        )
    )
    chunk_bytes = request.sample_rate * (BITS_PER_SAMPLE // 8) * DEFAULT_CHUNK_SECONDS
    for offset in range(0, len(request.pcm), chunk_bytes):
        yield AudioStream(
            audio_with_emotion=AudioWithEmotion(audio_buffer=request.pcm[offset : offset + chunk_bytes])
        )
    yield AudioStream(end_of_audio=AudioStream.EndOfAudio())


def analyze_with_nim(request: AudioRequest, cache_key: str) -> dict[str, Any]:
    import grpc
    from nvidia_ace.services.a2f_controller.v1_pb2_grpc import A2FControllerServiceStub

    started = time.monotonic()
    channel = _create_grpc_channel()
    shape_names: list[str] | None = None
    frames: list[dict[str, Any]] = []
    terminal_status: int | None = None
    terminal_message = ""
    try:
        responses = A2FControllerServiceStub(channel).ProcessAudioStream(
            _request_messages(request),
            timeout=NIM_TIMEOUT_SECONDS,
        )
        for message in responses:
            part = message.WhichOneof("stream_part")
            if part == "animation_data_stream_header":
                header = message.animation_data_stream_header
                shape_names = list(header.skel_animation_header.blend_shapes)
            elif part == "animation_data":
                animation = message.animation_data
                if not animation.HasField("skel_animation"):
                    continue
                for blendshapes in animation.skel_animation.blend_shape_weights:
                    frames.append(
                        {
                            "timeCode": float(blendshapes.time_code),
                            "values": [float(value) for value in blendshapes.values],
                        }
                    )
            elif part == "status":
                terminal_status = int(message.status.code)
                terminal_message = message.status.message
                if terminal_status == 3:
                    raise BridgeError(
                        "AUDIO2FACE_NIM_ERROR",
                        terminal_message or "NVIDIA Audio2Face reported an inference error.",
                        502,
                    )
    except grpc.RpcError as exc:
        raise BridgeError(
            "AUDIO2FACE_NIM_UNAVAILABLE",
            f"NVIDIA Audio2Face gRPC request failed: {exc.code().name}.",
            502,
        ) from exc
    finally:
        channel.close()

    if terminal_status is None:
        raise BridgeError("AUDIO2FACE_STREAM_INCOMPLETE", "Audio2Face ended without a terminal status.", 502)
    if terminal_status != 0:
        raise BridgeError(
            "AUDIO2FACE_STREAM_NOT_SUCCESSFUL",
            terminal_message or f"Audio2Face ended with status {terminal_status}.",
            502,
        )
    if not shape_names or not frames:
        raise BridgeError("AUDIO2FACE_EMPTY_RESULT", "Audio2Face returned no animation frames.", 502)
    for index, frame in enumerate(frames):
        if len(frame["values"]) != len(shape_names):
            raise BridgeError(
                "AUDIO2FACE_FRAME_WIDTH_MISMATCH",
                f"Audio2Face frame {index} does not match its shape header.",
                502,
            )
    duration_ms = max(request.duration_ms, frames[-1]["timeCode"] * 1000)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "status": "success",
        "fps": OUTPUT_FPS,
        "shapeNames": shape_names,
        "frames": frames,
        "durationMs": duration_ms,
        "cacheHit": False,
        "cacheKey": cache_key,
        "processingMs": round((time.monotonic() - started) * 1000, 3),
        "tongueRequested": TONGUE_REQUESTED,
    }


def analyze_cached(request: AudioRequest) -> dict[str, Any]:
    cache_key = CACHE.key_for(request)
    cached = CACHE.load(cache_key)
    if cached is not None:
        return cached
    lock = _lock_for(cache_key)
    lock.acquire()
    try:
        cached = CACHE.load(cache_key)
        if cached is not None:
            return cached
        payload = analyze_with_nim(request, cache_key)
        CACHE.store(cache_key, payload)
        return payload
    finally:
        lock.release()
        _release_lock(cache_key, lock)


def parse_audio_request(body: bytes, sample_rate_header: str | None) -> AudioRequest:
    if not body:
        raise BridgeError("AUDIO2FACE_AUDIO_REQUIRED", "PCM audio body is required.", 400)
    if len(body) > MAX_AUDIO_BYTES:
        raise BridgeError("AUDIO2FACE_AUDIO_TOO_LARGE", "PCM audio exceeds the bridge size limit.", 413)
    if len(body) % 2 != 0:
        raise BridgeError("AUDIO2FACE_AUDIO_MALFORMED", "PCM16 audio must contain complete 16-bit samples.", 400)
    try:
        sample_rate = int(sample_rate_header or "")
    except ValueError as exc:
        raise BridgeError(
            "AUDIO2FACE_SAMPLE_RATE_REQUIRED",
            "x-batshit-audio-sample-rate must be an integer.",
            400,
        ) from exc
    if sample_rate < 8_000 or sample_rate > 96_000:
        raise BridgeError(
            "AUDIO2FACE_SAMPLE_RATE_UNSUPPORTED",
            "Audio2Face sample rate must be between 8000 and 96000 Hz.",
            400,
        )
    return AudioRequest(pcm=body, sample_rate=sample_rate)


class Handler(BaseHTTPRequestHandler):
    server_version = "BatshitAudio2FaceBridge/0.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[audio2face-bridge] {self.address_string()} {format_string % args}", flush=True)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _authorized(self) -> bool:
        authorization = self.headers.get("authorization", "")
        expected = f"Bearer {AUTH_TOKEN}"
        return hmac.compare_digest(authorization.encode("utf-8"), expected.encode("utf-8"))

    def _require_authorization(self) -> bool:
        if self._authorized():
            return True
        self._send_json(401, {"ok": False, "code": "UNAUTHORIZED", "error": "Authorization required."})
        return False

    def do_GET(self) -> None:
        if self.path == "/live":
            self._send_json(200, {"ok": True, "service": "batshit-audio2face-bridge", "version": BRIDGE_VERSION})
            return
        if self.path == "/health":
            if not self._require_authorization():
                return
            ready, reason = probe_nim()
            self._send_json(
                200,
                {
                    "ok": ready,
                    "bridgeRunning": True,
                    "nimReady": ready,
                    "reason": reason,
                    "service": "batshit-audio2face-bridge",
                    "version": BRIDGE_VERSION,
                    "protocol": "nvidia-audio2face-3d-v2-bidirectional-grpc",
                    "outputFps": OUTPUT_FPS,
                    "cacheSchema": SCHEMA_VERSION,
                },
            )
            return
        self._send_json(404, {"ok": False, "code": "NOT_FOUND", "error": "Route not found."})

    def do_POST(self) -> None:
        if self.path != "/v1/analyze":
            self._send_json(404, {"ok": False, "code": "NOT_FOUND", "error": "Route not found."})
            return
        if not self._require_authorization():
            return
        try:
            content_length = int(self.headers.get("content-length", ""))
        except ValueError:
            self._send_json(411, {"ok": False, "code": "LENGTH_REQUIRED", "error": "Content-Length is required."})
            return
        if content_length < 1 or content_length > MAX_AUDIO_BYTES:
            self._send_json(413, {"ok": False, "code": "AUDIO2FACE_AUDIO_TOO_LARGE", "error": "PCM audio exceeds the bridge size limit."})
            return
        try:
            body = self.rfile.read(content_length)
            request = parse_audio_request(body, self.headers.get("x-batshit-audio-sample-rate"))
            payload = analyze_cached(request)
            self._send_json(200, payload)
        except BridgeError as exc:
            self._send_json(exc.status, {"ok": False, "code": exc.code, "error": str(exc)})
        except Exception as exc:
            print(f"[audio2face-bridge] unexpected request failure: {exc}", flush=True)
            self._send_json(
                500,
                {"ok": False, "code": "AUDIO2FACE_BRIDGE_FAILURE", "error": "Audio2Face bridge request failed."},
            )


def main() -> None:
    print(
        f"[audio2face-bridge] listening on {HOST}:{PORT}; NIM={NIM_ENDPOINT}; TLS={NIM_TLS}; cache={CACHE_DIR}",
        flush=True,
    )
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
