# Standard Artifact Builder Guide

You are helping a user build a Batshit artifact — a persistent mini-app that lives in their workspace. This guide walks you through the entire process step by step.

This guide covers **standard artifacts**: text tools, image generators, TTS tools, dashboards, calculators, form processors, and anything that uses Batshit's built-in AI or external APIs directly. If you're building a ComfyUI, n8n workflow, or HuggingFace-specific artifact, you should be reading that domain's reference doc instead — not this one.

## Step 0: Builder Kit Contract (Mandatory)

Batshit now enforces artifact structure at save time unless the user manually turned that toggle off for this artifact in Settings -> Artifacts.

- You must build with **Builder Kit** (`window.batshit.builder.*`)
- You must include a **Fabric runtime contract** (`metadata.fabric_fields` or `metadata.run_only=true`)
- If you declare `fabric_fields`, your HTML must include matching `fabricId` bindings
- Result artifacts should include `standardControls()` unless the user explicitly wants something else

If you skip those things, the artifact will not save. This is enforced by Batshit, not just recommended in docs.

Before you write artifact code, lock this mini-plan:

1. List the user-facing fields
2. Map each field to a Builder Kit primitive
3. Pick the `fabricId` values
4. Plan where each component will mount with `window.batshit.builder.mount(target, component)`
5. Plan the matching `metadata.fabric_fields`
6. Start the artifact body with the usable interface, not a repeated title/description block
7. Run `sys.artifact.validate_structure` before the first save

### Fast Mental Checklist

- [ ] Prompt-like input -> `builder.form.textarea()` or `builder.form.text()`
- [ ] Dropdown -> `builder.form.select()`
- [ ] Numeric control -> `builder.form.slider()` or `builder.form.number()`
- [ ] Output actions -> `builder.action.standardControls()`
- [ ] Components are mounted with `builder.mount(target, component)` or appended as `component` / `component.shell`
- [ ] Form values are tracked through `onChange` or `component.input`
- [ ] Every user-facing control has a `fabricId`
- [ ] Every `fabricId` is represented in `metadata.fabric_fields`, unless this is truly `run_only`
- [ ] The body does not repeat the artifact name as an `h1` or top title
- [ ] Description text appears only if it gives necessary instructions, context, or a user-requested note

If you catch yourself reaching for raw `<input>`, `<select>`, or `<textarea>` as the main UI path, stop and switch back to Builder Kit first.

---

## Before You Start

Load the `references/builder-kit-api.md` reference for form components, output displays, action controls, and other universal building blocks **before** you analyze fields or sketch the UI. Use the reference-reading method available in your current lane.

The AI-specific methods (text completion, image generation, speech, structured objects) are documented here in this guide — you don't need builder-kit-api for those.

Also load `zone-patterns` if you want full working layout examples for the target zone, or `templates-gallery` if you're starting from a template.

---

## Step 1: Research What the User Wants

Before writing a single line of code, search for up-to-date information about what the user is requesting.

Use `native_web_search` (or built-in web search if available in the CLI runtime). Look for:

- **What is this thing?** If unfamiliar, search for it — users frequently request tools built around new projects and APIs that shipped after your training cutoff.
- **Latest version, API docs, or changelog** — even familiar technologies evolve.
- **Common patterns and examples** — what do well-built implementations look like?
- **Known issues or gotchas** — what should you avoid?

Skipping research is like coding without reading the docs — technically possible, but almost always produces worse results.

**If web search is unavailable:** Tell the user: *"Web search would help me build a better artifact here. If you have Batshit Web Search enabled (Settings → Tools), I can research this first."* Then proceed with what you know.

---

## Step 2: Understand the Goal

Read the user's message carefully:

- What does the user want the artifact to **do**?
- How will they **use it**? (frequently, occasionally, as a one-click action)
- Does it need **AI capabilities**? If so, which ones? (text, images, speech, structured data)

Most artifacts use Batshit's built-in AI — that covers text completion, image generation, speech synthesis, and structured object streaming. This is the default and handles 90%+ of use cases. Only reach for external APIs or webhooks if the user specifically needs something the built-in AI doesn't cover.

Never ask the user "what brain type do you want?" Instead, use Artifact Power Source language: "I'll set this up as Built-in AI" or "I'll set the Artifact Power Source to Custom Webhook."

**If the user hasn't told you what to build yet, stop here and ask.** Don't continue until you have a clear build request.

---

## Step 3: Pick the Right Zone

Every artifact lives in a workspace zone. Pick one based on how the artifact will be used:

| Zone | Best For | Design Approach |
|---|---|---|
| **panel** | Rich tools needing space — dashboards, generators, multi-section layouts | Full layouts with grids, generous spacing, 14-16px text |
| **header** | Focused tools opened as overlay cards — quick references, compact utilities | Card-based, self-contained, medium density |
| **trigger** | One-click actions with inline preview — quick launchers, status checks | Compact dropdown, minimal UI, form + button + small result area |

Always confirm the target zone with the user before publishing. If unsure, suggest the best fit based on the artifact's complexity.

---

## Step 4: Build It

Time to write the code. Here are your building blocks:

### Your Building Tools (Core Artifact Controls)

These are the Fabric controls you use to create and manage artifacts. Use the control transport available in your current lane:

- In-app system skill lane: discover and call the exact Fabric refs through Batshit's app-provided tool controls.
- Portable skill lane: call the same `controlId` values through `POST /api/controls/use` with the Portable Skill Token.

| controlId | What It Does | Required | Optional |
|---|---|---|---|
| `sys.artifact.create` | Create a new artifact | `name`, `content` (full HTML) | `mode` ("edit"/"published"), `zone`, `icon_ref` |
| `sys.artifact.update` | Update content or settings | `artifactId` | `content`, `versionDescription`, `mode` |
| `sys.artifact.validate_structure` | Preflight-check Builder Kit + Fabric before save | `artifactId` or `content` | `metadata`, `mode` |
| `sys.artifact.apply_patch` | Apply a diff patch to existing artifact HTML | `artifactId`, `patch` | `versionDescription` |
| `sys.artifact.publish` | Publish or unpublish | `artifactId` | `publish` (bool), `zone` |
| `sys.artifact.get` | Fetch artifact details | `artifactId` | `includeContent`, `includeVersions`, `includeVersionContents` |
| `sys.artifact.list` | List all user artifacts | — | returns compact summaries by default |
| `sys.artifact.set_zone` | Set workspace zone | `artifactId` | `zone` ("header"/"panel"/"trigger") |
| `sys.artifact.set_webhook` | Set webhook config | `artifactId` | `webhook_url`, `ai_enabled` (bool), `brain_type` |
| `sys.artifact.add_version` | Save a version snapshot | `artifactId`, `content` | `description` |
| `sys.artifact.rollback` | Rollback to previous version | `artifactId`, `targetVersion` (int) | — |
| `sys.artifact.delete_version` | Delete a saved version | `artifactId`, `version` (int) | — |
| `sys.artifact.analyze_url` | Analyze external source URL | `url` | `hfToken`, `githubToken` |
| `sys.artifact.check_requirements` | Check dependency requirements | `path` or `url` | — |

### Preflight Rule (Do This Before Every Save)

Before every `sys.artifact.create`, `sys.artifact.update`, `sys.artifact.apply_patch`, and `sys.artifact.publish`, run `sys.artifact.validate_structure`.

Why:
- It catches Builder Kit/Fabric mistakes before the actual save call
- It warns you if `standardControls()` is missing
- It helps on later adjustment passes too, not just the first build

Treat this as part of the normal artifact loop:
1. draft code
2. run `sys.artifact.validate_structure`
3. fix anything it reports
4. save

**How to call them:**
```json
{
  "controlId": "sys.artifact.create",
  "input": {
    "name": "My Tool",
    "content": "<!DOCTYPE html>...",
    "mode": "edit",
    "icon_ref": { "kind": "lucide", "id": "search" }
  }
}
```

**Important response rule:** lifecycle writes (`create`, `update`, `apply_patch`, `publish`, version/webhook/zone mutations) return compact summaries, not the full HTML body. If you need to inspect or continue editing the actual source, call `sys.artifact.get`. By default `get` includes current `content` but trims historical `versions[].content`; opt into `includeVersionContents: true` only when you truly need old version bodies.

**Edit rule:** for targeted changes to an existing artifact, prefer `sys.artifact.apply_patch` over resending the whole HTML. Use `sys.artifact.update` with full `content` when you are doing a major rewrite or replacing the document wholesale. Artifact patches use the standard apply_patch grammar and must target exactly `*** Update File: artifact.html`.

If `sys.artifact.apply_patch` returns `context did not match`, call `sys.artifact.get` again and rebuild the patch from the current source. After two failed targeted patch attempts, switch to `sys.artifact.update` with full `content` only if you can preserve the entire current document exactly.

**Exact `sys.artifact.apply_patch` payload example:**
```json
{
  "controlId": "sys.artifact.apply_patch",
  "input": {
    "artifactId": "...",
    "versionDescription": "Tighten spacing in output card",
    "patch": "*** Begin Patch\n*** Update File: artifact.html\n@@\n-  <div class=\"card\">\n+  <div class=\"card compact\">\n*** End Patch"
  }
}
```

Patch string shown with newlines expanded:

```txt
*** Begin Patch
*** Update File: artifact.html
@@
-  <div class="card">
+  <div class="card compact">
*** End Patch
```

Do **not** use unified diff headers like `--- a/...` / `+++ b/...`.
Do **not** send JSON objects or arrays as `patch`.
Do **not** omit the `*** Begin Patch` / `*** End Patch` markers.
Context lines may be copied directly from the source, including indentation. Removed lines still need `-`; added lines still need `+`.

### Always Create a New Artifact

For each build request, create a **new** artifact with `sys.artifact.create`. Don't modify existing artifacts unless the user explicitly asks to update a specific one by name or ID.

### Icon Field

Always set `icon_ref` to a structured icon-picker reference that fits the artifact's purpose. Do not send raw emoji icons, do not use the legacy `icon` field, and do not invent Lucide icon IDs from memory. If you say you chose an icon, the `sys.artifact.create` or `sys.artifact.update` payload must include `icon_ref`.

Common first-pass choices:
- `{ kind: "lucide", id: "search" }` for search tools
- `{ kind: "lucide", id: "book-open" }` for knowledge-base tools
- `{ kind: "lucide", id: "image" }` for image tools
- `{ kind: "lucide", id: "palette" }` for creative/static mood, color, and style tools
- `{ kind: "lucide", id: "sparkles" }` for general AI helper tools
- `{ kind: "lucide", id: "wand-sparkles" }` for prompt improvement or magic-edit tools
- `{ kind: "lucide", id: "audio-lines" }` for TTS or audio tools
- `{ kind: "lucide", id: "chart-bar" }` for dashboards and data tools
- `{ kind: "brand", slug: "huggingface-color" }` for Hugging Face spaces
- `{ kind: "brand", slug: "gradio-color" }` for Gradio apps outside Hugging Face
- `{ kind: "brand", slug: "comfyui-color" }` for ComfyUI artifacts
- `{ kind: "brand", slug: "n8n-color" }` for n8n workflow artifacts
- `{ kind: "batshit", id: "artifacts" }` as the neutral fallback if none of the above fit

Do not use `{ kind: "lucide", id: "smile" }`; that icon is not currently available in Batshit's picker catalog.

Also set `metadata.source_type` when the artifact clearly belongs to a runtime/source family. Valid values are `built_in`, `comfyui`, `huggingface`, `gradio`, `n8n`, `custom`, and `static`. This drives the small source badge Batshit renders separately from the main chosen icon and the Artifact Power Source selector in Settings.

### Action Bar Rule (Non-Negotiable)

If the artifact produces results, render this exact control bar:
- **Share to Chat**
- **Save to Clip Vault**
- **Download**

Use `window.batshit.builder.action.standardControls()` as the single source of truth. Do NOT build custom share/save/download buttons. Do NOT auto-share by default. Do NOT disable, hide, relabel, or reorder these three controls unless the user explicitly asks for a different UI.

### Use Builder Kit Primitives

Default to builder-kit primitives for all standard UI elements. Only use raw HTML when the builder kit genuinely doesn't have what you need.

Think of builder-kit like Batshit's component library — using primitives gives you consistent theming, proper hover/disabled/focus/loading states, and future theme compatibility for free.

The `window.batshit.builder` namespace provides:

- **Form inputs** (`builder.form.*`): text, textarea, select, multiselect, checkbox, toggle, radio, slider, number, promptPair, uploadButton, dropFile
- **Output displays** (`builder.output.*`): text, markdown, media, table, statusCard, resultCard
- **Actions** (`builder.action.*`): run, shareToChat, saveToClipVault, download, standardControls, reset, publishStatus
- **Layout**: `builder.createRoot(options)`, `builder.mount(target, child)`

Builder Kit components are real DOM elements with handles attached. Use `builder.mount(target, component)` as the default, and use `component.input` when you need the underlying input/select/textarea. Avoid code that assumes a Builder Kit return value is a plain wrapper object.

See `builder-kit-api` for the full component reference with all options.

**When raw HTML IS appropriate**: truly custom visualizations (charts, canvas, 3D renders), novel layouts with no primitive equivalent, or when the user explicitly wants a unique visual style.

### CSS Theme System

All artifacts receive Batshit theme variables. Always use these instead of hardcoded colors:

**Colors**: `--batshit-bg`, `--batshit-surface`, `--batshit-surface-elevated`, `--batshit-surface-inset`, `--batshit-text`, `--batshit-text-strong`, `--batshit-text-secondary`, `--batshit-muted`, `--batshit-faint`, `--batshit-accent`, `--batshit-accent-hover`, `--batshit-accent-foreground`, `--batshit-accent-soft`, `--batshit-accent-faint`, `--batshit-success`, `--batshit-danger`, `--batshit-warning`, `--batshit-info`, `--batshit-border`, `--batshit-border-strong`, `--batshit-border-subtle`, `--batshit-field`, `--batshit-field-hover`, `--batshit-field-border`, `--batshit-field-border-hover`

**Layout**: `--batshit-radius-sm` (4px), `--batshit-radius` (8px), `--batshit-radius-lg` (12px)

**Typography**: `--batshit-font` (Geist Sans with system fallback), `--batshit-font-mono` (Geist Mono with monospace fallback)

Always use fallbacks: `var(--batshit-bg, oklch(0.11 0.02 276))` so artifacts render correctly even if injection fails.

**Design tips**:
- Accent color (`--batshit-accent`) for primary actions and interactive highlights
- Surface/elevated for card backgrounds, field tokens for inputs
- Border-subtle for lightweight dividers, border/field-border for prominent boundaries
- Text for primary content, text-secondary for labels, muted for hints
- Success/danger/warning/info for semantic status indicators
- Do not use the accent color for an artifact title. Batshit already renders the artifact title outside the iframe.

---

## Step 5: AI Capabilities Reference

These are the `window.batshit` methods for AI-powered artifacts. This section is the complete API reference — parameters, return types, examples, and pitfalls.

### Text Completion — `window.batshit.complete(prompt, options)`

The core method for streaming text completion. Used for summarizers, analyzers, chat tools, content generators, and anything that needs AI text output.

**Parameters:**
- `prompt` (string, required): The text prompt to send to the AI
- `options` (object, optional):
  - `mode` (string): `'complete'`, `'enhance'`, `'fix'`, `'explain'`
  - `context` (object): Additional context data passed to the AI
  - `onChunk(chunk)`: Called with each text delta during streaming
  - `onEnd(result)`: Called when streaming completes
  - `onError(error)`: Called on failure
  - `onFile(dataUrl, mediaType, event)`: Called when image files are generated (see multimodal section below)
  - `onAudio(audioData, mediaType, event)`: Called when audio is generated

**Returns:** `{ text, files?, metadata }`

**Example — basic text completion:**
```javascript
const result = await window.batshit.complete('Summarize this data', {
  mode: 'complete',
  context: { data: myData },
  onChunk: (chunk) => { output.textContent += chunk; },
  onEnd: () => { status.textContent = 'Done'; },
  onError: (err) => { status.textContent = 'Error: ' + err.message; }
});
```

### Multimodal Image Generation via `complete()` + `onFile`

Some current image-capable models generate images through the text completion path, not through `generateImage()`. Use `complete()` with an `onFile` callback when the selected current model/provider returns files through completion streaming:

```javascript
let imageUrl = null;

const result = await window.batshit.complete('Generate the requested image', {
  onChunk: (chunk) => { /* optional: show text response */ },
  onFile: (dataUrl, mediaType, event) => {
    // dataUrl is ALREADY a full data URL — use it directly
    imageUrl = dataUrl;
    document.getElementById('output').src = dataUrl;
  },
  onEnd: () => { status.textContent = imageUrl ? 'Image ready' : 'No image returned'; },
  onError: (err) => { status.textContent = 'Error: ' + err.message; }
});
```

**⚠️ Common `onFile` mistake — do NOT double-wrap the data URL:**
```javascript
// WRONG — produces a broken src:
onFile: (dataUrl, mediaType) => {
  img.src = `data:${mediaType};base64,${dataUrl}`;  // BUG! dataUrl is already complete
}

// CORRECT — dataUrl is already a full data URL:
onFile: (dataUrl, mediaType) => {
  img.src = dataUrl;
}
```

### Shortcut Methods

These are pre-configured wrappers around `complete()`:

- **`window.batshit.enhance(prompt, context)`** — Enhance existing content. Equivalent to `complete(prompt, { mode: 'enhance', context })`.
- **`window.batshit.fix(prompt, context)`** — Fix content with AI guidance.
- **`window.batshit.explain(prompt, context)`** — Explain content.

---

### Image Generation — `window.batshit.generateImage(prompt, options)`

Generate images from text prompts using a dedicated image model selected by the user or found through Batshit's model catalog.

Use the top-level runtime helper exactly as `window.batshit.generateImage(prompt, options)`. If you alias `const b = window.batshit`, call `b.generateImage(prompt, options)`. Do **not** call `window.batshit.ai.generateImage` or `b.ai.generateImage`; `window.batshit.ai` is not a runtime namespace.

**Parameters:**
- `prompt` (string, required): Image description
- `options` (object, optional):
  - `model` (string): exact current image model ID selected by the user/catalog
  - `n` (number): Number of images (default: 1, max varies by model)
  - `size` (string): Dimensions like `'1024x1024'` when supported by the selected model
  - `aspectRatio` (string): Ratio like `'16:9'` when supported by the selected model
  - `styleRef` (object): Style reference image `{ url, weight }`
  - `characterRef` (object): Character reference `{ url, weight }`
  - `onProgress` (function): Progress callback `({ status, file }) => void`

**Returns:** `{ image, images, text, metadata }`

**⚠️ CRITICAL — understand the return type:**
- `result.image` → **string** — a full data URL ready for `<img src>` (e.g., `"data:image/png;base64,iVBOR..."`)
- `result.images` → **array of objects** — NOT strings! Each element: `{ base64: string, mediaType: string, index: number }`
- `result.image` is a shortcut equal to `result.images[0].base64`

**Single image (most common):**
```javascript
const selectedImageModelId = '<exact-current-image-model-id>';
const result = await window.batshit.generateImage('A sunset over mountains', {
  model: selectedImageModelId,
  size: '1024x1024'
});
if (result.image) {
  document.getElementById('output').src = result.image;
}
```

**Multiple images:**
```javascript
const selectedImageModelId = '<exact-current-image-model-id>';
const result = await window.batshit.generateImage('A cute cat in space', {
  model: selectedImageModelId,
  n: 2,
  size: '1024x1024'
});
const container = document.getElementById('gallery');
container.innerHTML = '';
for (const imgObj of result.images) {
  const img = document.createElement('img');
  img.src = imgObj.base64;  // full data URL, ready for img.src
  img.alt = `Generated image ${imgObj.index + 1}`;
  img.style.maxWidth = '100%';
  container.appendChild(img);
}
```

**Common image generation mistakes:**
- Do NOT loop both `result.image` and `result.images` — same data, shown twice
- `result.images[i]` is an object, NOT a string. Use `.base64` for the data URL
- Images are 3-5 MB each. Do NOT pass them to raw `shareToChat()` (16 KB limit). Use `standardControls()` with an `image` key in the share payload
- If the artifact supports source/reference images and agents should be able to call it, expose image URL/data URI fields as text controls with semantic Fabric IDs such as `source-image-1-url`, `source-image-2-url`, and `source-image-3-url`. Batshit maps those fields to structured image inputs for image-capable built-in models; browser file-upload controls still cannot be agent-settable Fabric fields.
- For user-operated Clip Vault source picking, use `window.batshit.listClipSources()` to populate image choices and `window.batshit.resolveClipSource(clipId)` only after the user selects one. The resolver prefers the user's current tunnel/public URL and falls back to bounded stored image data; do not persist full image data in artifact storage.

### Image Editing — `window.batshit.editImage(options)`

Modify existing images with natural language instructions.

**Parameters:**
- `options.prompt` (string, required): Edit instruction
- `options.image` (string, required): Source image URL or `data:image/...` URI
- `options.model` (string, optional): Model to use
- `options.weight` (number, optional): Strength of edit (0-1)

**Returns:** `{ image, images, text, metadata }` (same shape as `generateImage`)

---

### Speech / TTS — `window.batshit.speak(text, options)`

Convert text to speech. Returns an audio URL you can play directly.

**Parameters:**
- `text` (string, required): Text to speak
- `options` (object, optional):
  - `model` (string): exact current speech model ID selected by the user/catalog
  - `voice` (string): voice ID supported by the selected model/provider

**Returns:** `{ audioData, audioUrl, mediaType, text, metadata }`

```javascript
const selectedSpeechModelId = '<exact-current-speech-model-id>';
const selectedVoiceId = '<provider-supported-voice-id>';
const result = await window.batshit.speak('Hello, welcome!', {
  model: selectedSpeechModelId,
  voice: selectedVoiceId
});
if (result.audioUrl) {
  const audio = new Audio(result.audioUrl);
  audio.play();
}
```

---

### Structured Object Streaming — `window.batshit.streamObject(options)`

Stream structured JSON objects with progressive updates. Great for dashboards, product lists, data tables, or any structured output that benefits from appearing incrementally.

**Parameters:**
- `options.prompt` (string, required): Generation prompt
- `options.schema` (object, required): JSON Schema defining the expected output structure
- `options.schemaName` (string, optional): Name for the schema
- `options.schemaDescription` (string, optional): Description of expected output
- `options.onPartial(partialObject)`: Called with each incremental update

**Returns:** `{ object, text, metadata }`

```javascript
const result = await window.batshit.streamObject({
  prompt: 'Generate 5 product ideas',
  schema: {
    type: 'object',
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price: { type: 'number' },
            description: { type: 'string' }
          }
        }
      }
    }
  },
  onPartial: (partial) => {
    renderProducts(partial);
  }
});
```

---

### Model Selection

Model names move quickly. Do not copy old examples from memory and do not imply one image generator is Batshit's global artifact default. The artifact itself should own its model choice.

Use this rule instead:

1. If the artifact request clearly names or implies a provider/model family, search Batshit's catalog first with `sys.model_catalog.search`. Example input: `{ "query": "Nano Banana 2 Gemini Flash Image", "provider": "google", "purpose": "visual", "limit": 5 }`.
2. Batshit vocabulary matters:
   - **Provider** = the API key/connection route Batshit will call, such as Google direct, OpenAI direct, or OpenRouter.
   - **Developer** = the model maker namespace, such as Google, OpenAI, Anthropic, Black Forest Labs, etc.
   - **Model ID** = the exact callable model string. For artifact `model_config`, use the catalog result's `modelIdForArtifact`.
   - **Connection** = the catalog variant route, such as `direct:google`, `direct:fal`, `openrouter`, or `vercel-gateway`. If the user names a provider/connection, prefer the result whose variant matches that route.
3. Store the selected model during creation when possible. Finished provider/model-branded built-in AI artifacts should include the chosen catalog result's `artifact.modelConfig` in `sys.artifact.create`.
4. If you already created the artifact and need to repair the model, use `sys.artifact.update` with the same manual `model_config` shape, or use the per-instance control `artifact.<id>.field.model.set` with `{ "model": "<modelIdForArtifact>" }`.
5. Do not omit `model_config` for a finished provider/model-branded artifact. Omitted config normalizes to `source: "auto"` with `modelId: null`; that is a draft/no-model state, not a working model selection, and built-in AI runtime calls will fail clearly until an exact model is selected or supplied per call.
6. Never silently choose a fallback or substitute model because the intended model is unavailable, unclear, expensive, or not in the catalog. A fallback model can create surprise behavior, surprise API cost, and hidden reliability problems because the user may never learn that the intended model/provider is failing. Ask the user before substituting.
7. Use current provider docs or web search only when Batshit's catalog cannot answer the exact model ID and the user request clearly requires a current/provider-branded model. If the model remains ambiguous, ask the user.
8. If the user did not name or imply a model and the artifact needs built-in AI, ask one short question such as: "Which exact model should this artifact use?"
9. If the artifact intentionally lets the user choose among multiple models at runtime, make that explicit in the UI and pass the selected exact model ID in every `window.batshit.complete()` / `generateImage()` / speech call. Do not leave the artifact on No model selected unless every runtime call provides a model.
10. If the model is a dedicated image/speech provider path, use `generateImage()` or the speech helper. If the current model returns images through completion streaming, use `complete()` with `onFile`. For image artifacts, choose a result whose `artifact.runtime.outputKind` is `image`; `purpose: "visual"` also includes video and 3D models.
11. Do not use `source: "preset"` unless the user explicitly named an existing saved Model Manager preset and you know its exact saved preset ID. Never invent a preset ID from the artifact name or provider nickname; Batshit rejects unknown preset IDs.

Model catalog result interpretation:

- `artifact.modelConfig` is the exact model_config object to store for a normal single-model built-in AI artifact.
- `modelIdForArtifact` is the only value you put into `model_config.primary.modelId`.
- `artifact.runtime.connection`, `provider.connectionId`, and `variants[].connectionId` tell you which API route can call the model. Use them to choose the right result, not as extra fields in `model_config`.
- `artifact.runtime.outputKind` tells you whether a visual model is an `image`, `video`, `3d`, or broader visual runtime. Use `image` for `generateImage()` artifacts.
- `artifact.runtime.savedApiKeyService` tells you which user-saved provider key is required for direct artifact runtime calls. Check saved-key availability through your current lane when that context is available. Portable agents must ask the user whether that key is saved in Batshit or guide them to save it. You can verify presence, but you cannot read the secret value. If the key is missing, ask the user to add that saved provider key; do not use an env key or silently switch providers.
- `developer` tells you who made the model. A Google-made model served through Fal may have `developer: "google"` but `connectionId: "direct:fal"`. If the user asked for Google direct, do not choose the Fal variant unless they approve that provider change.
- `purpose` must match the artifact job, but it is not enough by itself for images. Image generators need `artifact.runtime.outputKind: "image"` or an obviously image-capable catalog row. Chat/completion, video, or 3D models can save successfully, but they will not produce image files for an image artifact.

Wrong model modality warning: setting a chat/completion, video, or 3D model ID on an image artifact may pass structure validation but fail at runtime with no image output. Always verify the catalog result's artifact runtime details before saving the model.

Exact manual `model_config` shape:

```json
{
  "model_config": {
    "mode": "basic",
    "primary": {
      "source": "manual",
      "modelId": "<modelIdForArtifact>"
    }
  }
}
```

Do not add `provider`, `developer`, `connection`, `transport`, or `effectiveId` fields to `model_config`. Batshit stores the exact manual model ID and rehydrates connection/purpose from the catalog at runtime. If the catalog is unavailable or a call returns `CONTROL_NOT_ALLOWED`, treat that as a Batshit control-scope problem, not a sandbox/full-permissions problem. Report the blocker plainly. If the user already supplied an exact model ID, use it; otherwise ask a short question instead of guessing or silently falling back.

After setting or repairing model config:

1. Call `sys.artifact.get`.
2. Confirm `artifact.model_config.primary.source === "manual"`.
3. Confirm `artifact.model_config.primary.modelId` equals the selected `modelIdForArtifact`.
4. Run the artifact once and inspect run logs if the output is missing or wrong. For image artifacts, inspect logs even when the tool reports success; `result.fileCount` or runtime `generatedFileCount` must be greater than 0.

---

## Step 6: Common Mistakes to Avoid

These are mistakes that don't fit neatly into the API sections above but still trip up agents regularly.

### Inline onclick handlers with dynamic strings — use dataset instead

When building lists or grids dynamically, never put dynamic strings in `onclick` attributes — the quotes break:

```js
// ❌ BROKEN — double quotes inside double-quoted attribute
item.innerHTML = '<button onclick="deleteDoc(' + JSON.stringify(doc.source) + ')">Remove</button>';

// ✅ CORRECT — no quoting issues
const btn = document.createElement('button');
btn.dataset.source = doc.source;
btn.addEventListener('click', function() {
  deleteDoc(this.dataset.source);
});
```

### Script tag safety

Never write literal `</script>` inside a `<script>` block — it prematurely closes the tag. Use `<\/script>` if you must reference it in JavaScript strings.

### JavaScript preflight errors

`sys.artifact.validate_structure` also syntax-checks inline `<script>` blocks. If it reports invalid JavaScript, fix the HTML and run validation again before saving.

Inside real artifact JavaScript, do not escape template-literal backticks or interpolation:

```js
// Broken in real JS
const url = \`${API}/\${path}\`;

// Correct
const url = `${API}/${path}`;
```

### Model/config troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `sys.artifact.update` returns success but the model looks unchanged | Wrong payload shape, wrong artifact ID, or you checked a stale summary instead of the full record | Call `sys.artifact.get`, inspect `artifact.model_config`, then retry with the exact manual shape above |
| `CONTROL_NOT_ALLOWED` when using `sys.model_catalog.search` | Fabric context allow-list issue, not a sandbox/full-permissions issue | Report it as a Batshit control-scope blocker. If the user has already supplied an exact model ID, use it; otherwise ask for the exact model ID instead of guessing |
| Run finishes very quickly with no image/file output | Chat/completion, video, or 3D model selected for an image artifact; saved provider key missing; or runtime call used the wrong helper | Search catalog with `purpose: "visual"`, choose a result with `artifact.runtime.outputKind: "image"`, verify the required saved key exists in Batshit, update config, verify with `sys.artifact.get`, and run again |
| Validation passes but runtime produces the wrong output type | Structure validation checks artifact shape, not provider modality | Verify `artifact.runtime.outputKind` from the catalog and inspect `sys.artifact.run_logs.get` |
| Multiple catalog rows look similar | Same developer model is available through different provider connections | Pick the connection the user asked for; if changing provider/connection, ask first |

---

## Step 7: Configure

After creating the artifact:

1. **Set the zone** via `sys.artifact.set_zone` (if you didn't set it during creation)

2. **Set the artifact model** if the artifact uses built-in AI. If the artifact's purpose clearly implies a model family, search `sys.model_catalog.search` and set the returned `artifact.modelConfig` during creation with manual `model_config`, or use the per-instance control `artifact.<id>.field.model.set` with `{ model: "<modelIdForArtifact>" }` immediately after creation. The model value must be the actual provider model ID string — not a role name like "primary," not a display nickname, and not a guessed saved preset ID. Do not choose a fallback/substitute model without user permission. Ask which exact current model to use when the artifact is generic, the intended model is unavailable, or the model choice is genuinely ambiguous.

3. **Do not rely on Auto/no-model.** Clearing the model selection leaves the artifact with no model. Runtime calls fail clearly until an exact manual model ID is selected or the artifact passes an exact model on every runtime call.

4. **Use run logs for runtime debugging.** If a test run fails, inspect `sys.artifact.run_logs.list` and `sys.artifact.run_logs.get` before changing code or model settings. For generated-image artifacts, inspect logs before handoff and require `result.fileCount` or runtime `generatedFileCount` to be greater than 0. The log shows chat linkage, a scrubbed prompt preview, the resolved model, chosen transport, output counts, usage, and sanitized errors without exposing secrets or raw image/audio bytes. Run logs are retained for about two weeks, deleted when the Artifact is deleted, and kept across Artifact version edits, rollbacks, or version deletion.

5. **Configure the system prompt** if needed via the per-instance `artifact.<id>.field.system_prompt.set` control.

6. **Set a webhook URL** if using an external API via `sys.artifact.set_webhook`.

---

## Step 8: Finish Up — Agent Access and Publishing

Your artifact is built and configured! Now load the `fabric-and-agent-use` reference to set up agent access and publish it yourself.

Load `references/fabric-and-agent-use.md` through your current reference-reading lane. It walks you through asking the user about agent access, configuring Fabric fields, testing, and publishing.

**Do not skip this step.** Even if the user didn't mention agent access, the Fabric setup ensures the artifact is ready for it whenever they want it. When the build is done, publish it yourself instead of sending the user into Settings to do it manually.

---

## Secure API Key Access

### `window.batshit.env(keyName)`

Retrieve a user's API key by service name. Used when artifacts need to call external APIs directly (e.g., Perplexity, HuggingFace, ElevenLabs).

**Parameters:** `keyName` (string) — e.g., `'perplexity'`, `'huggingface'`, `'openai'`, `'fal'`, `'elevenlabs'`

**Returns:** `string | null` — the decrypted key, or `null` if not configured

```javascript
const apiKey = await window.batshit.env('perplexity');
if (!apiKey) {
  outputEl.textContent = 'Please add your Perplexity API key in Settings → API Keys';
  return;
}
```

**Rules:**
- Infrastructure keys (`batshit_token`, `n8n_api_key`, etc.) are blocked
- Key names are case-insensitive and auto-trimmed
- Rate limited to 30 requests per minute
- Always check saved-key availability through the current lane before building artifacts that depend on specific keys

---

## Multi-Session Builds (Blueprint)

For complex artifacts that span multiple sessions:

- Set the blueprint field on creation with the user's vision and plan
- Append milestones as you build ("Step 2 complete: form layout done, AI wiring next")
- When the user returns and says "continue working on X", read the blueprint to pick up where you left off
- Use `sys.artifact.get` to read the blueprint and `sys.artifact.update` to update it

---

## Importing from External Sources

Artifacts can be imported from external sources:

- **HuggingFace**: Gradio spaces, model demos
- **GitHub**: Raw HTML/JS files
- **n8n**: Workflows scaffolded as webhook-triggered artifacts
- **URL**: Direct HTML content

Use `sys.artifact.analyze_url` to evaluate import candidates. Size cap is 200 KB.
