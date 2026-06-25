# Artifact Builder Kit — Component & Utility Reference

This is your reference for the universal `window.batshit` APIs — the building blocks every artifact uses regardless of Artifact Power Source. Form inputs, output displays, action controls, storage, events, and utilities.

**Every Power Source path loads this doc.** Whether you're building a General artifact, ComfyUI wrapper, n8n frontend, or HuggingFace tool — the components here are your UI toolkit.

**For AI-specific methods** (text completion, image generation, speech, structured objects): those are in `brain-general`. They only apply to standard artifacts using Batshit's built-in AI. ComfyUI and n8n artifacts have their own API patterns documented in their brain docs.

---

## Core Properties

These are available the moment the artifact iframe loads:

| Property | Type | What It Tells You |
|---|---|---|
| `window.batshit.artifactId` | string | This artifact's unique ID |
| `window.batshit.artifactName` | string | Display name the user sees |
| `window.batshit.artifactWebhook` | string or null | Webhook URL if one is configured |
| `window.batshit.apiVersion` | string | API version (currently `'1.0.0'`) |
| `window.batshit.ready` | boolean | `true` when the API is fully initialized — wait for this before calling methods |
| `window.batshit._fetch` | function | Fetch wrapper for Batshit artifact API calls. It attaches the sandbox runtime token and avoids cookie dependence from opaque artifact iframes. Use this for Batshit same-origin artifact endpoints such as `/api/artifacts/comfyui/...`. Do not use it for outside APIs. |
| `window.batshit.resolveMediaUrl` | function | Converts protected same-origin artifact media URLs, currently ComfyUI `/api/artifacts/comfyui/view?...` URLs, into display-safe blob URLs by fetching with the sandbox runtime token. Use it before assigning protected result URLs to `<img>`, `<video>`, or `<source>` when writing explicit render code. |
| `window.batshit.listClipSources()` | function | Lists Clip Vault image sources for this artifact runtime. Returns metadata only; it does not return image bytes. |
| `window.batshit.resolveClipSource(clipId, options?)` | function | Resolves one Clip Vault image into a source input. Prefers the user's current tunnel/public URL when available, otherwise returns bounded image data from stored upload data. |

---

## Layout

Two helpers for creating and assembling your artifact's DOM structure:

**`window.batshit.builder.createRoot(options)`** — Creates a styled root container element with Batshit theme defaults applied.

**`window.batshit.builder.mount(target, child)`** — Mounts a builder component (form field, output display, etc.) into a target DOM element.

Batshit already renders the artifact name, icon, source badge, and artifact controls in the surrounding panel/header chrome. Treat `createRoot()` as the content body, not as a place to add a second title/header. Start with the actual controls, status, or result area. Add a top note only when it gives necessary instructions or a user-requested reminder.

Builder Kit components are DOM elements with convenience handles attached:

- `component.shell` points to the same DOM element, so older `appendChild(component.shell)` code still works.
- Form components expose `component.input` for the underlying input/select/textarea.
- Action bars expose `actions.buttons` for the individual action buttons.

Use `builder.mount(target, component)` as the safest default. Direct `target.appendChild(component)` also works because components are real DOM elements.

---

## Form Components (`window.batshit.builder.form.*`)

These are your input primitives. Each one returns a DOM element you can mount into your layout.

| Component | What It Does | Key Options |
|---|---|---|
| `text(options)` | Single-line text input | `label`, `placeholder`, `value`, `onChange`, `fabricId` |
| `textarea(options)` | Multi-line text area | `label`, `placeholder`, `rows`, `onChange`, `fabricId` |
| `select(options)` | Dropdown picker | `label`, `options[]`, `value`, `onChange`, `fabricId` |
| `multiselect(options)` | Multi-select dropdown | `label`, `options[]`, `values[]`, `onChange`, `fabricId` |
| `checkbox(options)` | Checkbox | `label`, `checked`, `onChange`, `fabricId` |
| `toggle(options)` | Toggle switch (alias for checkbox) | `label`, `checked`, `onChange`, `fabricId` |
| `radio(options)` | Radio button group | `label`, `options[]`, `value`, `onChange`, `fabricId` |
| `slider(options)` | Range slider | `label`, `min`, `max`, `step`, `value`, `onChange`, `fabricId` |
| `number(options)` | Number input | `label`, `min`, `max`, `step`, `value`, `onChange`, `fabricId` |
| `promptPair(options)` | Dual textarea (positive + negative prompt) | `label`, `promptLabel`, `negativeLabel`, `onChange`, `fabricId` |
| `uploadButton(options)` | File upload button | `label`, `accept`, `multiple`, `onFiles` |
| `dropFile(options)` | Drag-and-drop zone | `label`, `accept`, `onFiles` |

Every component accepts `onChange` (called with the new value when the user interacts) and optionally `fabricId` (makes the field agent-callable — see below).

---

## `fabricId` — Making Form Fields Agent-Callable

Adding `fabricId` to a form component registers it so agents can fill it programmatically through the artifact runtime wrappers. This is how artifacts become agent tools — the agent discovers the artifact, sees its fields, and sets values with a single call.

```javascript
// Agent sees this field as "positive-prompt"
const promptField = window.batshit.builder.form.textarea({
  label: 'Positive Prompt',
  placeholder: 'Describe what you want to generate...',
  fabricId: 'positive-prompt',
  onChange: (val) => { state.positivePrompt = val; }
})

// Agent sees this field as "image-size"
const sizeField = window.batshit.builder.form.select({
  label: 'Image Size',
  options: ['512x512', '768x768', '1024x1024'],
  value: '1024x1024',
  fabricId: 'image-size',
  onChange: (val) => { state.imageSize = val; }
})

// Agent sees this field as "num-steps"
const stepsField = window.batshit.builder.form.number({
  label: 'Steps',
  min: 1, max: 150, value: 25,
  fabricId: 'num-steps',
  onChange: (val) => { state.steps = parseInt(val); }
})

const controls = document.getElementById('controls')
window.batshit.builder.mount(controls, promptField)
window.batshit.builder.mount(controls, sizeField)
window.batshit.builder.mount(controls, stepsField)
```

**How it works under the hood:**
- Primitives with `fabricId` register in the artifact's field registry
- The registry is reported to the parent frame when the artifact loads
- After publishing, backend-runnable artifacts can be discovered by agents as `use.artifact.{slug}` with a typed parameter schema
- When an agent calls the artifact, field values are injected via `batshit:set-fields` postMessage and `onChange` handlers fire automatically
- User-only panel artifacts, including Gradio/HuggingFace embeds and current ComfyUI panel artifacts, still use Builder Kit controls for the UI but are not agent-runnable.

**Supported on:** `text`, `textarea`, `select`, `multiselect`, `checkbox`, `toggle`, `radio`, `slider`, `number`, `promptPair`

**Not supported on:** `uploadButton`, `dropFile` (browser security prevents programmatic file input)

**`window.batshit.getFabricFields()`** — returns all registered fabric field metadata:
```javascript
const fields = window.batshit.getFabricFields()
// Returns: [{ fabricId, type, label, required, options, min, max }, ...]
```

**Important for n8n artifacts:** fabricId values MUST exactly match the `$json.body.*` keys your n8n workflow reads. See `brain-n8n` for the fabricId Golden Rule.

---

## Output Components (`window.batshit.builder.output.*`)

Display components for rendering results:

| Component | What It Does | Key Options |
|---|---|---|
| `text(content, options)` | Plain text block | `className` |
| `markdown(content, options)` | Markdown-rendered content | `className` |
| `media(src, options)` | Image, video, or audio player | `type`, `alt`, `controls` |
| `table(rows, options)` | Formatted data table | `headers`, `className` |
| `statusCard(options)` | Status indicator card | `title`, `status` (`'success'`/`'warning'`/`'error'`), `message` |
| `resultCard(result, options)` | Result display card | `title`, `content`, `actions` |

---

## Action Controls (`window.batshit.builder.action.*`)

| Method | What It Does |
|---|---|
| `run(options)` | Execute an AI completion action |
| `shareToChat(content, options)` | Share output to parent chat |
| `saveToClipVault(content, options)` | Persist output as a clip without a chat message |
| `download(content, options)` | Download text/JSON/data-url/blob as a file |
| `standardControls(options)` | The standard trio: Share to Chat + Save to Clip Vault + Download |
| `reset(options)` | Reset form fields to defaults |
| `publishStatus()` | Check artifact publish readiness and zone compatibility |

### Standard Action Controls (Non-Negotiable Default)

Every artifact that produces results **must** include the standard action bar:

```javascript
const actions = window.batshit.builder.action.standardControls({
  storageKey: 'lastResult',
  title: 'Image Analysis',
  shareOptions: { type: 'result', format: 'markdown', initiator: 'user' }
});
window.batshit.builder.mount(root, actions);
```

This renders three consistent buttons: **Share to Chat**, **Save to Clip Vault**, **Download**. Do NOT build custom share/save/download buttons. Do NOT auto-share by default.

**When your data isn't in storage** — use `getPayload` (or `getSharePayload` / `getDownloadPayload`):

```javascript
window.batshit.builder.action.standardControls({
  getPayload: () => ({
    title: 'Workflow Output',
    data: latestOutputMarkdown
  }),
  downloadOptions: { filename: 'workflow-output.md', mimeType: 'text/markdown' }
});
```

**For image artifacts** — include the image in the share payload so Batshit can upload it safely (raw images exceed the 16KB shareToChat limit):

```javascript
window.batshit.builder.action.standardControls({
  title: 'Generated Image',
  getSharePayload: () => ({
    title: 'Generated Image',
    image: result.image,
    data: `Prompt: ${prompt}\nModel: ${model}`
  }),
  shareOptions: { type: 'data', format: 'markdown', initiator: 'user' }
});
```

**Hiding a button** (only if the user explicitly asks):
```javascript
window.batshit.builder.action.standardControls({
  share: true,
  save: true,
  download: false  // hide Download for this artifact
});
```

**What to share**: include useful, actionable context. For image artifacts: the image + readable metadata (prompt/model/settings). For text artifacts: the actual result text. For structured data: `format: 'markdown'` with a formatted summary so agents can parse it.

**Make titles meaningful**: `"RAG Upload Result"`, `"Image Analysis"`, `"Workflow Output"` — not `"Result"`.

---

## Share to Chat (Low-Level API)

### `window.batshit.shareToChat(content, options)`

Direct share API for pushing artifact output into the parent chat session. **For most cases, use `standardControls()` instead** — it handles images, size limits, and consistent UX.

**Parameters:**
- `content.title` (string): Title for the shared content
- `content.data` (string): Content to share
- `options.type` (string): Content type — `'data'`, `'result'`, etc.
- `options.format` (string): Format hint — `'markdown'`, `'text'`, `'json'`

**⚠️ 16 KB content limit.** Fine for text, JSON, and markdown. NOT fine for raw image data (3-5 MB each). For media sharing, always use `standardControls()`.

```javascript
// Good — text result via raw API
await window.batshit.shareToChat(
  { title: 'Analysis Results', data: analysisText },
  { type: 'data', format: 'markdown' }
);

// Bad — image via raw API (will fail or truncate)
await window.batshit.shareToChat({ title: 'Image', data: result.image }, { type: 'result' });
// Use standardControls() with image payload instead
```

---

## Local Storage

Namespaced per-artifact, persists across sessions. Useful for saving user preferences, last results, and configuration.

| Method | What It Does |
|---|---|
| `window.batshit.storage.get(key)` | Get a stored value (auto-parsed from JSON) |
| `window.batshit.storage.set(key, value)` | Store a value (auto-serialized to JSON) |
| `window.batshit.storage.remove(key)` | Delete a specific key |
| `window.batshit.storage.clear()` | Clear all storage for this artifact |

---

## Events

Internal event bus for component communication within the artifact:

| Method | What It Does |
|---|---|
| `window.batshit.events.on(event, callback)` | Listen for an event |
| `window.batshit.events.emit(event, data)` | Emit an event |
| `window.batshit.events.off(event, callback)` | Remove a listener |

---

## Metadata

### `window.batshit.getMetadata()`

Returns information about this artifact instance:

**Returns:** `{ id, name, type, version, features }`
- `features.files` (boolean): Image generation is available
- `features.audio` (boolean): Speech/TTS is available
- `features.streaming` (boolean): Object streaming is available

---

## Secure API Key Access

### `window.batshit.env(keyName)`

Retrieve a user's API key by service name. Used when artifacts need to call external APIs directly (e.g., Perplexity, HuggingFace, ElevenLabs).

**Parameters:** `keyName` (string) — the service key name (e.g., `'perplexity'`, `'huggingface'`, `'openai'`, `'fal'`, `'elevenlabs'`)

**Returns:** `string | null` — the decrypted key value, or `null` if not configured

**Throws:**
- `Error('Key not accessible from artifacts')` — infrastructure keys are blocked
- `Error('Rate limit exceeded')` — max 30 requests per minute

```javascript
const apiKey = await window.batshit.env('perplexity');
if (!apiKey) {
  outputEl.textContent = 'Please add your Perplexity API key in Settings → API Keys';
  return;
}

const response = await fetch('https://api.perplexity.ai/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'sonar-reasoning-pro',
    messages: [{ role: 'user', content: searchQuery }]
  })
});
```

**Key rules:**
- Infrastructure keys (`batshit_token`, `n8n_api_key`, `n8n_api_url`, etc.) are blocked and cannot be retrieved
- Key names are case-insensitive and auto-trimmed
- Always check for `null` and show a user-friendly message pointing to Settings → API Keys
- Check saved-key availability through the current lane before building artifacts that depend on specific keys
