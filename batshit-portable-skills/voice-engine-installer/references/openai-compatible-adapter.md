# OpenAI-Compatible Adapter Lane

Use this **only** when the speech server genuinely supports an OpenAI-style speech API. This is high-leverage when it's real — Batshit already knows how to talk to OpenAI endpoints, so setup is simpler. But "OpenAI-compatible" is claimed far more often than it's actually true.

---

## What "OpenAI-Compatible" Means

Batshit can treat an engine as `requestFormat: "openai-compatible"` when the server accepts:

**TTS:**
- POST to `/audio/speech` or `/v1/audio/speech`
- Body: `{ model, input, voice }` at minimum
- Optional: `response_format`, `speed`, `instructions`
- Returns audio bytes directly

**Batshit clone-profile extension for BYO TTS:**
- When an enabled BYO engine is `openai-compatible` and `supports.clone` is true, Batshit Voice Studio stores reference-audio clone profiles and later sends `ref_audio` plus optional `ref_text` in the normal `/audio/speech` request body.
- Wrapper servers for clone-capable local engines must accept those fields and use them as the voice reference. Do not claim clone support if the wrapper ignores them.
- Batshit also forwards selected provider options such as `lang_code`, `temperature`, `top_p`, `top_k`, and `repetition_penalty` when present in the saved defaults or voice profile.

**STT:**
- POST to `/audio/transcriptions` or `/v1/audio/transcriptions`
- Multipart form: `file` + `model`
- Optional: `language`
- Returns `{ "text": "..." }`

If the server accepts these shapes, this lane saves time. If not — even partially — use `batshit-byo` instead.

---

## The Verification Rule

**Do not assume any server is OpenAI-compatible.** Verify before registering.

### How to Verify

1. **Check the docs.** Look for explicit "OpenAI-compatible" claims. Generic "REST API" isn't the same thing.
2. **Check request shape.** Must accept the exact fields above. `text` instead of `input`? Not compatible.
3. **Check response shape.** TTS = raw audio bytes. STT = `{ "text": "..." }`.
4. **Test with a real request** if docs are unclear.

**Good verification:**
> *"Docs show `POST /v1/audio/speech` with `{ model, input, voice }` and returns `audio/mpeg`. Genuinely compatible — using the adapter lane."*

> *"README says 'OpenAI-compatible' but the API expects `{ text, speaker_id, language }`. That's not compatible — using standard BYO format instead."*

---

## About Hosting Location

This lane is about **request shape**, not where the server runs.

- **Local/self-hosted + OpenAI-compatible** — still follow install ownership and install root rules from `local-self-hosted-engines`. The adapter just simplifies the request format.
- **Remote/cloud + OpenAI-compatible** — Batshit does **not** support this as a user-added BYO path. Hosted providers are built-in-only.

---

## Standard Endpoints

| Endpoint | Typical Path | Notes |
|---|---|---|
| TTS | `/v1/audio/speech` or `/audio/speech` | Some servers omit `/v1` |
| STT | `/v1/audio/transcriptions` or `/audio/transcriptions` | Same |
| Voices | No standard path | OpenAI has no voices endpoint |
| Health | No standard path | Use whatever the server offers |

### Path Prefix

Check whether the prefix goes in `baseUrl` or `ttsPath`:
- `baseUrl`: `http://localhost:8000` or `http://localhost:8000/v1`
- `ttsPath`: `/audio/speech`

Verify with a real request. Don't guess.

---

## Registration Pattern

```json
{
  "controlId": "sys.voice.engine.register",
  "input": {
    "engineId": "my-openai-compat-server",
    "payload": {
      "name": "My TTS Server",
      "enabled": false,
      "baseUrl": "http://localhost:8000/v1",
      "ttsPath": "/audio/speech",
      "sttPath": "/audio/transcriptions",
      "healthPath": "/health",
      "requestFormat": "openai-compatible",
      "supports": { "tts": true, "stt": true, "clone": false },
      "expression": { "strategy": "none" },
      "readiness": { "mode": "health" },
      "voiceDiscovery": { "mode": "none" }
    }
  }
}
```

Key points:
- `requestFormat: "openai-compatible"` — Batshit sends `{ model, input, voice }` payloads
- When the real server also supports extra fields like `ref_audio` / `ref_text` and Batshit can supply them truthfully through managed voice profiles, `supports.clone` may be `true`; otherwise leave it `false`
- Voice discovery usually `"none"` (no standard voices endpoint)
- `ttsDefaults.modelId` when server needs a model on every request
- `ttsDefaults.voiceId` for default voice (Batshit falls back to `alloy` otherwise)
- `ttsDefaults.providerOptions.format` for non-`mp3` response format defaults

### Instructions Support

If the server uses the `instructions` field for style guidance:

```json
"expression": { "strategy": "instructions" },
"ttsDefaults": {
  "common": { "instructions": "Speak in a warm, friendly tone." }
}
```

Only set this if the server actually uses `instructions`. Most compatible servers ignore it.

### Voice Discovery

If the server adds a voice-list endpoint (non-standard for OpenAI), you can still configure `voiceDiscovery` with the verified path.

---

## When NOT to Use This Lane

Switch to `batshit-byo` when:

- Server expects `text` instead of `input`
- Server expects `speaker_id` instead of `voice`
- Server uses WebSocket or streaming-only
- Server returns base64 audio instead of raw bytes
- Server needs fields outside the OpenAI schema
- Docs are vague and you haven't tested

For CLI/Python-only engines, a small OpenAI-compatible wrapper is acceptable when it lives under the engine install root, exposes the exact endpoints above, returns raw audio bytes, and is verified by one real smoke request before registration. If the runtime is thread-sensitive, keep model load and inference on one dedicated worker thread; do not assume a web framework's request threads can safely share model objects.

**Tell the user why you switched:**
> *"This server isn't actually OpenAI-compatible — it expects a different request format. I'll use Batshit's standard BYO format instead. Works just as well, just means I map the fields manually."*

---

## Common OpenAI-Compatible Servers

Always verify — implementations change.

| Server | Usually Compatible? | Notes |
|---|---|---|
| **OpenAI** (actual) | Yes — reference implementation | Built-in to Batshit, not a BYO path |
| **vLLM** | Sometimes | Check version and model support |
| **LocalAI** | Often | Verify endpoint paths |
| **Ollama** (with speech) | Check current docs | Speech support is newer |
| **LiteLLM** | Often for STT | TTS varies |
| **Custom wrappers** | Verify | Depends entirely on implementation |

---

## Completion

Note in the completion report that the engine uses the OpenAI-compatible adapter — this tells the user (and future troubleshooting) that Batshit sends OpenAI-shaped requests.
