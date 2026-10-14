# AI Capabilities

**Load when:** the artifact calls AI from its page: text with `complete()`, images with `generateImage()` or `editImage()`, speech with `speak()`, or structured data with `streamObject()`. It lists parameters, return shapes, and the mistakes that break them. The model itself is chosen in `ai-models.md`.

These are top-level runtime helpers: `window.batshit.complete(...)`, `window.batshit.generateImage(...)`, and so on. If you alias `const b = window.batshit`, call `b.generateImage(...)`. There is no `window.batshit.ai` namespace.

Every call uses the artifact's saved model unless you pass an exact `model`, and the artifact's `system_prompt` on every run.

## Text: `window.batshit.complete(prompt, options)`

Streams a text completion. The core call for summarizers, rewriters, analyzers, and generators.

- `prompt` (string, required)
- `options.mode`: `'complete'` (default), `'enhance'`, `'fix'`, `'explain'`
- `options.context` (object): extra data, serialized into the prompt; keep it small
- `options.onChunk(chunk)`, `options.onEnd(result)`, `options.onError(message)` (a string)
- `options.onFile(dataUrl, mediaType, event)`: files a model returns while streaming (see below)
- `options.onAudio(audioData, mediaType, event)`
- `options.model` (string): an exact model ID for this call only

**Returns** `{ text, files?, metadata }`.

```javascript
let failed = false;
const result = await window.batshit.complete('Summarize this data', {
  context: { data: rows },
  onChunk: (chunk) => { output.textContent += chunk; },
  onError: (message) => { failed = true; status.textContent = 'Error: ' + message; }
});
if (!failed) window.batshit.storage.set('lastResult', result.text);
```

Disable the run button while a call streams, clear the output first, and handle both `onError` and a thrown error.

A provider stream failure calls `onError` and keeps text already delivered. The call can still resolve with that partial text; `onEnd` is not called for a failed stream. Track the error callback before treating the returned text as a successful result.

Shortcuts: `window.batshit.enhance(prompt, context)`, `.fix(prompt, context)`, `.explain(prompt, context)` are `complete()` with that mode.

### Images through `complete()` + `onFile`

Some image-capable models return images through the completion stream instead of `generateImage()`. Then use `complete()` with `onFile`. `dataUrl` is already a full data URL:

```javascript
await window.batshit.complete('Generate the requested image', {
  onFile: (dataUrl) => { img.src = dataUrl; }   // not `data:${mediaType};base64,${dataUrl}`
});
```

## Images: `window.batshit.generateImage(prompt, options)`

- `options.model`: exact image model ID (the artifact's saved model when omitted)
- `options.n` (number of images), `options.size` (`'1024x1024'`) or `options.aspectRatio` (`'16:9'`), when the model supports them
- `options.styleRef` / `options.characterRef`: `{ url, weight }`
- `options.onProgress({ status, file })`

**Returns** `{ image, images, text, metadata }`:

- `result.image` is a **string**: a full data URL for `<img src>`.
- `result.images` is an **array of objects** `{ base64, mediaType, index }`, where `base64` is also a full data URL. `result.image` equals `result.images[0].base64`.
- Show one or the other, never both (the same picture twice).

```javascript
const result = await window.batshit.generateImage(prompt, { n: 2, size: '1024x1024' });
gallery.replaceChildren(...result.images.map((item) => {
  const img = document.createElement('img');
  img.src = item.base64;
  img.alt = 'Generated image ' + (item.index + 1);
  return img;
}));
```

Images are several MB each: share them through `standardControls()` with an `image` key in the share payload, never through raw `shareToChat()` (16 KB limit).

### Source and reference images

- For agents, expose image inputs as text fields with semantic `fabricId`s: `source-image-1-url`, `source-image-2-url`, `source-image-3-url` (also `reference-image-url`, `input-image-url`). For an image-capable model Batshit sends them as structured image inputs, and maps `image-count`, `aspect-ratio`, and xAI `resolution` to run options. File-upload controls cannot be agent fields.
- For the user, `window.batshit.listClipSources()` lists Clip Vault images (metadata only) and `window.batshit.resolveClipSource(clipId)` resolves the one they pick (a tunnel or public URL when available, else bounded image data). Do not store full image data in artifact storage.

## Image editing: `window.batshit.editImage(options)`

`options.prompt` (edit instruction) and `options.image` (a URL or `data:image/...` URI) are required; `options.model` and `options.weight` (0-1) are optional. Returns the same shape as `generateImage()`.

## Speech: `window.batshit.speak(text, options)`

`options.model` (exact speech model ID) and `options.voice` (a voice the model supports). Returns `{ audioData, audioUrl, mediaType, text, metadata }`.

```javascript
const speech = await window.batshit.speak(text, { voice: voiceId });
if (speech.audioUrl) new Audio(speech.audioUrl).play();
```

## Structured data: `window.batshit.streamObject(options)`

Streams a JSON object that fills in as it arrives; good for lists, tables, and dashboards.

- `options.prompt` and `options.schema` (JSON Schema) are required
- `options.schemaName`, `options.schemaDescription`, `options.onPartial(partialObject)`

**Returns** `{ object, text, metadata }`.

```javascript
const { object } = await window.batshit.streamObject({
  prompt: 'Five product ideas',
  schema: { type: 'object', properties: { products: { type: 'array', items: {
    type: 'object', properties: { name: { type: 'string' }, pitch: { type: 'string' } } } } } },
  onPartial: (partial) => render(partial)
});
```

## Which helper

| Job | Helper |
|---|---|
| Text in, text out | `complete()` |
| Dedicated image model | `generateImage()` |
| Image model that answers through chat streaming | `complete()` + `onFile` |
| Change an existing picture | `editImage()` |
| Read text aloud | `speak()` |
| Typed JSON result | `streamObject()` |

For an image artifact, pick a model whose catalog row says `artifact.runtime.outputKind: "image"` (`ai-models.md`); a chat, video, or 3D model saves fine and then returns no picture.

## Calling an outside API

When the job needs a service Batshit does not route, call it from the page with the user's saved key: `const key = await window.batshit.env('perplexity')`. `env()` returns `null` when the key is not saved; tell the user to add it in Settings -> API Keys. Details and limits are in `runtime-api.md`.
