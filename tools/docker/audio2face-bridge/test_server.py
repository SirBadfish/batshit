import json
import os
import tempfile
import unittest
from pathlib import Path


os.environ.setdefault("BATSHIT_AUDIO2FACE_BRIDGE_TOKEN", "test-token")
os.environ.setdefault("BATSHIT_AUDIO2FACE_CACHE_DIR", tempfile.mkdtemp())

import server


class Audio2FaceBridgeTests(unittest.TestCase):
    def test_pcm_request_validation_is_fail_loud(self):
        request = server.parse_audio_request(b"\x00\x00\x01\x00", "16000")
        self.assertEqual(request.sample_rate, 16000)
        self.assertEqual(request.duration_ms, 0.125)
        with self.assertRaisesRegex(server.BridgeError, "complete 16-bit samples"):
            server.parse_audio_request(b"\x00", "16000")
        with self.assertRaisesRegex(server.BridgeError, "between 8000 and 96000"):
            server.parse_audio_request(b"\x00\x00", "4000")

    def test_cache_key_binds_audio_rate_protocol_endpoint_and_tongue_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = server.ResultCache(Path(directory), 10_000, 10)
            first = server.AudioRequest(b"\x00\x00", 16000)
            same = server.AudioRequest(b"\x00\x00", 16000)
            different_rate = server.AudioRequest(b"\x00\x00", 24000)
            different_audio = server.AudioRequest(b"\x01\x00", 16000)
            self.assertEqual(cache.key_for(first), cache.key_for(same))
            self.assertNotEqual(cache.key_for(first), cache.key_for(different_rate))
            self.assertNotEqual(cache.key_for(first), cache.key_for(different_audio))

    def test_cache_write_is_atomic_and_hits_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = server.ResultCache(Path(directory), 10_000, 10)
            request = server.AudioRequest(b"\x00\x00", 16000)
            key = cache.key_for(request)
            payload = {
                "schemaVersion": server.SCHEMA_VERSION,
                "status": "success",
                "cacheKey": key,
                "cacheHit": False,
                "frames": [],
            }
            cache.store(key, payload)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])
            loaded = cache.load(key)
            self.assertIsNotNone(loaded)
            self.assertTrue(loaded["cacheHit"])

    def test_corrupt_cache_fails_instead_of_silently_recomputing(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = server.ResultCache(Path(directory), 10_000, 10)
            request = server.AudioRequest(b"\x00\x00", 16000)
            key = cache.key_for(request)
            cache._path(key).write_text("{broken", encoding="utf-8")
            with self.assertRaises(server.CacheCorruptionError):
                cache.load(key)

    def test_cache_prunes_oldest_entries_but_preserves_new_write(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = server.ResultCache(Path(directory), 10_000, 2)
            paths = []
            for index in range(3):
                key = f"{index:064d}"
                path = cache._path(key)
                path.write_text(json.dumps({"index": index}), encoding="utf-8")
                os.utime(path, ns=(index + 1, index + 1))
                paths.append(path)
            cache.prune(keep=paths[-1])
            self.assertFalse(paths[0].exists())
            self.assertTrue(paths[1].exists())
            self.assertTrue(paths[2].exists())


if __name__ == "__main__":
    unittest.main()
