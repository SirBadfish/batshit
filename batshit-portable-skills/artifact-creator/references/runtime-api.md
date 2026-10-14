# Artifact Runtime API

**Load when:** the artifact needs more than Builder Kit and AI calls: per-artifact storage, the event bus, its own metadata, a user's saved API key for an outside service, Clip Vault images, Batshit's same-origin fetch, or the low-level share call.

## Core properties

| Property | What it is |
|---|---|
| `window.batshit.artifactId` / `.artifactName` | This artifact's ID and display name |
| `window.batshit.artifactWebhook` | The saved webhook URL, or `null` |
| `window.batshit.apiVersion` | Runtime API version |
| `window.batshit.ready` | `true` once the runtime is set up |
| `window.batshit._fetch(url, init)` | `fetch` for Batshit's own artifact endpoints (such as `/api/artifacts/comfyui/...`): it attaches the artifact's runtime token. Not for outside APIs |
| `window.batshit.resolveMediaUrl(url)` | Turns a protected same-origin media URL (such as a ComfyUI `/view` result) into a blob URL an `<img>`, `<video>`, or `<source>` can show |

## Storage (per artifact, kept across sessions)

| Method | What it does |
|---|---|
| `window.batshit.storage.get(key)` | Reads a value (parsed from JSON) |
| `window.batshit.storage.set(key, value)` | Stores a value (serialized to JSON) |
| `window.batshit.storage.remove(key)` | Deletes one key |
| `window.batshit.storage.clear()` | Clears this artifact's storage |

Keep it for preferences, the last result (the action bar reads `lastResult` by default), and small state. Do not store full image data.

```javascript
const saved = window.batshit.storage.get('dashboard');
if (saved) restore(saved.stats);
window.batshit.storage.set('dashboard', { refreshedAt: new Date().toISOString(), stats });
```

## Events

`window.batshit.events.on(event, callback)`, `.emit(event, data)`, and `.off(event, callback)`: a small bus for parts of the same page.

## Metadata

`window.batshit.getMetadata()` returns `{ id, name, type, version, features }`, where `features.files` (image generation), `features.audio` (speech), and `features.streaming` (object streaming) say what this runtime offers.

## Saved API keys: `window.batshit.env(keyName)`

Returns the user's saved key for a service (`'perplexity'`, `'huggingface'`, `'openai'`, `'fal'`, `'elevenlabs'`, ...), or `null` when none is saved.

```javascript
const apiKey = await window.batshit.env('perplexity');
if (!apiKey) {
  output.textContent = 'Add your Perplexity API key in Settings -> API Keys.';
  return;
}
const response = await fetch('https://api.perplexity.ai/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: question }] })
});
```

- Infrastructure keys (`batshit_token`, `n8n_api_key`, `n8n_api_url`, ...) are refused: `Error('Key not accessible from artifacts')`.
- At most 30 calls a minute (`Error('Rate limit exceeded')`); read a key once per run, not per keystroke.
- Names are case-insensitive and trimmed.
- Before you build around a key, check `user_api_keys_configured` in your session context (a portable agent asks the user). You can see whether a key is saved, never its value.
- Never write a key into the artifact HTML, storage, or a shared result.

## Clip Vault images

- `window.batshit.listClipSources()`: the user's Clip Vault images for this runtime, as metadata only.
- `window.batshit.resolveClipSource(clipId, options?)`: resolves the one the user picked into a source input, preferring their current tunnel or public URL and falling back to bounded stored image data.

## Low-level share: `window.batshit.shareToChat(content, options)`

Pushes Artifact output into the current chat. The server labels runtime shares as Artifact output, not human instructions; an `initiator` option cannot override this. Prefer `builder.action.standardControls()`, which handles images, size limits, and the standard buttons.

- `content.title`, `content.data`; `options.type` (`'data'`, `'result'`, ...), `options.format` (`'markdown'`, `'text'`, `'json'`).
- For image action-bar payloads, use image data or a public HTTP(S) URL. Local/private service URLs are refused; use the saved ComfyUI/Pinokio proxy to obtain image data first. Remote downloads have a 10 MiB / 10 second total limit; originals are copied into local Clip storage.
- **16 KB limit:** fine for text, JSON, and Markdown; never for raw image data (use the action bar's `image` payload).

```javascript
await window.batshit.shareToChat({ title: 'Analysis results', data: analysisText }, { type: 'data', format: 'markdown' });
```
