# Pinokio App Artifacts

**Load when:** the user wants an artifact around an app installed in Pinokio (a ComfyUI, a Gradio app, or an app with its own HTTP API), or a Pinokio app artifact says its app is not running.

Pinokio installs and runs AI apps on this computer. A **Pinokio App** artifact calls the app's own API through Batshit; Pinokio only reports where the app answers and starts it. Unlike a plain ComfyUI panel or a Gradio embed, agents can run it (`artifact:use.artifact.{slug}`), because Batshit's server runs the app for them.

## The payload

```json
{
  "brain_type": "pinokio_app",
  "metadata": {
    "source_type": "comfyui",
    "runtime_manager": "pinokio",
    "pinokio_app_id": "comfy.git",
    "fabric_fields": [{ "fabricId": "prompt", "type": "textarea", "label": "Prompt" }],
    "pinokio_runtime": { "...": "the recipe for this kind, below" }
  }
}
```

- `source_type` is the app's real kind: `"comfyui"`, `"gradio"`, or `"custom"`. Never `"pinokio"`.
- `pinokio_app_id` is the folder id `fabric:sys.pinokio.search` returns (`comfy.git`). Never store a URL, `localhost`, a port, a `ready_url`, or a `pinokio://` ref: Batshit asks Pinokio where the app answers on every run.
- Agent use is on by default, like any runnable artifact. The badge reads "ComfyUI via Pinokio".
- `icon_ref`: ComfyUI `{ kind: "brand", slug: "comfyui-color" }`, Gradio `{ kind: "brand", slug: "gradio-color" }`, custom `{ kind: "lucide", id: "rocket" }`.

A save checks all of this and says what to fix. A draft may leave `pinokio_runtime` out; publishing needs it.

## Steps

1. **Find the app.** `fabric:sys.pinokio.search` (input `{}`, or `{ "query": "ocr" }`). If Pinokio is not detected or not running, say so plainly: the user opens Pinokio. Batshit never installs apps; if the app is not installed, the user installs it in Pinokio.
2. **Read its API while it runs.** `fabric:sys.pinokio.app_status` with `{ "appId": "...", "describeApi": true }`. If it is offline, start it with `fabric:sys.pinokio.run` (`{ "appId": "..." }`); the user approves every start. `describeApi` answers:
   - **Gradio:** the named endpoints with their parameters in order, each with a name, component, type, and default, and their `returns`, each with a `position`.
   - **ComfyUI:** load the user's saved workflow with `fabric:sys.comfyui.workflows` and `baseUrl` set to the app's `readyUrl` (`action: "list"`, then `"get"` with `includeWorkflow: true`). Plan the fields as in `brain-comfyui.md`, then store the **API-format** node map.
   - **Neither:** a custom API. Ask the user which endpoint to call if its docs are not clear.
3. **Write the recipe** (below) and the fields.
4. **Build the UI** with Builder Kit, as usual (`builder-kit-api.md`). The panel runs the same recipe as agents, through `window.batshit.complete`. Never call the app yourself from the page: no `/api/artifacts/comfyui` proxy, no submit-and-poll, no `localhost` (that code skips Batshit's runner and the **Start with Pinokio** offer). Do not load `comfyui-build.md` for a Pinokio App artifact. The whole panel is this shape:

```javascript
// The page body holds <div id="app"></div>; this script runs after it.
const builder = window.batshit.builder;
const root = builder.createRoot();
document.getElementById('app').appendChild(root);
const values = { prompt: '', steps: 4 };
builder.mount(root, builder.form.textarea({ label: 'Prompt', fabricId: 'prompt', rows: 3, onChange: (v) => { values.prompt = v; } }));
builder.mount(root, builder.form.slider({ label: 'Steps', fabricId: 'steps', min: 1, max: 8, value: 4, onChange: (v) => { values.steps = Number(v); } }));
const out = document.createElement('div');
const go = document.createElement('button');
go.className = 'batshit-builder-button';
go.textContent = 'Generate';
go.onclick = async () => {
  go.disabled = true;
  out.textContent = 'Working…';
  try {
    const result = await window.batshit.complete('Run', { context: values, onError: (message) => { out.textContent = message; } });
    if (result.files.length > 0) {
      out.innerHTML = '';
      const img = document.createElement('img');
      img.src = result.files[0].base64;
      img.alt = values.prompt;
      img.style.maxWidth = '100%';
      out.appendChild(img);
      window.batshit.storage.set('lastResult', { title: 'Generated image', image: result.files[0].base64, data: 'Prompt: ' + values.prompt });
    } else if (result.text) {
      out.textContent = result.text;
    }
  } finally {
    go.disabled = false;
  }
};
root.appendChild(go);
root.appendChild(out);
builder.mount(root, builder.action.standardControls({ storageKey: 'lastResult', title: 'Generated image' }));
```

A text app shows `result.text` instead (and stores `{ title, data: result.text }`).
5. **Publish** (`mode: "published"`, usually the **panel** zone), then **run it once** yourself with `artifact:use.artifact.{slug}` and the field values, so you know it works before you say so.

## Recipes (`metadata.pinokio_runtime`)

### ComfyUI

```json
{
  "workflow": { "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "a cat", "clip": ["4", 1] } } },
  "inputs": { "prompt": { "node": "6", "input": "text" }, "steps": { "node": "3", "input": "steps" } },
  "randomSeed": { "node": "3", "input": "seed" }
}
```

- `workflow` is the whole API-format prompt (`{ node id: { class_type, inputs } }`), never the UI graph.
- `inputs` maps each `fabricId` to the workflow input it fills. Only value inputs, never links such as `["4", 1]`. A number stays a number. An agent's run uses ONLY this map, so every field must map to one workflow input: offer `width` and `height` as two fields, not an "aspect ratio" the page translates.
- `randomSeed` gives every run a new seed unless a field sets it. Set it (to the sampler's `seed`): without it every run of the same prompt returns the same picture. Do not add a seed field to `inputs` unless the user wants to type seeds.
- The workflow must save its picture (`SaveImage`); each saved image comes back as a file. Image inputs (`LoadImage`) are not supported in a ComfyUI recipe yet.

### Gradio

```json
{
  "api_name": "/predict",
  "inputs": [{ "field": "image", "file": true }, { "field": "prompt" }, { "value": 1024 }],
  "outputs": [1]
}
```

- One entry per endpoint parameter, **in order**, as `describeApi` lists them: a field's value, or a fixed `value` for a parameter the artifact does not expose (use its default). When a run leaves a field empty, Batshit sends the default the app declares for that parameter.
- `"file": true` for an image, audio, or file parameter. Its field value is a Clip id (`clip_...`, as the chat's Clips roster lists an attached picture), a public `https` URL, a Batshit Clip URL, or a `data:` URL. Batshit uploads it to the app. When you RUN such an artifact for the user, pass the attached Clip's id; do not read the picture yourself instead. A file field is a Builder Kit `form.text` with the `fabricId` (agents pass a URL); in the panel, add a `dropFile` whose file you read as a data URL and pass in `context` under the same `fabricId`.
- `outputs` lists the `position` of each returned value that is the result, in the order to show them. Apps often also return a preview of the input, a status line, or a slider update: leave those out, or every run shares the preview picture into the chat and repeats the text. If two returns hold the same text (a Markdown view and a raw box), keep one. Left out, everything is kept.
- Kept text comes back as `text`, kept images as files (shared into the chat when an agent runs it).

### Custom API

```json
{ "method": "POST", "path": "/api/generate" }
```

The field values are sent as the JSON body. A JSON answer's `text`, `output`, `result`, or `response` becomes the text (otherwise the whole JSON); an image answer becomes a file.

## When the app is not running

- **An agent run** answers with an error that says the app is not running and names `fabric:sys.pinokio.run`. Call it right away: Batshit shows the user an **Approve** card for the start, so do not ask in chat first. Then run the artifact again. If it says the app is still starting, check `fabric:sys.pinokio.app_status` and run again once it is online.
- **The panel** shows "Start with Pinokio" by itself. The user confirms in Batshit, the app starts, and the run repeats. There is nothing to build for this.

## Panels that call the app directly

A custom UI can reach its own app through Batshit's proxy: `window.batshit.pinokio.fetch('<path>', init)` calls `/api/artifacts/pinokio/<path>` (it also offers the start when the app is off). ComfyUI apps allow the ComfyUI paths (`prompt`, `history/<id>`, `view`, `object_info`, `system_stats`, `upload/image`, ...), Gradio apps the Gradio API (`gradio_api/...`), and custom apps any path. Show proxied ComfyUI images with `await window.batshit.resolveMediaUrl(url)`. Prefer `window.batshit.complete()` unless the panel needs something the recipe cannot do: it is one code path for the user and for agents.

## Raw embed stays the opt-out

If the user only wants the app's own page inside Batshit, use the Gradio embed (`embed-gradio.md`). It is user-only: no fields, no agent use, and it needs enforcement switched off. Say so before choosing it.
