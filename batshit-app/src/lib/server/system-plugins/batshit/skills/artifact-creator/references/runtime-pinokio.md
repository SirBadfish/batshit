# Pinokio App Artifacts

**Load when:** the user wants an artifact around an app installed in Pinokio (a ComfyUI, a Gradio app, or an app with its own HTTP API), or a Pinokio app artifact says its app is not running.

Pinokio installs and runs AI apps on this computer or on a saved computer on the user’s trusted LAN; a remote one needs no local Pinokio. A **Pinokio App** artifact calls the app's own API through Batshit; Pinokio only reports where the app answers and starts it. Unlike a plain ComfyUI panel or a Gradio embed, agents can run it (`artifact:use.artifact.{slug}`), because Batshit's server runs it for them.

**Portable Artifact Creator:** these are the in-app Pinokio controls. An Artifacts-scoped Portable Skill Token manages Artifacts only, not `sys.pinokio.*` discovery/start or session-only connection routes: use supplied owned machine/app facts or have the user use the in-app agent for discovery/start; never borrow session credentials.

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
- For a saved remote computer, add only `metadata.pinokio_machine_id` (the owned UUID from `fabric:sys.pinokio.status`); a local Artifact may leave it out. To move a remote Artifact to This computer, save `pinokio_machine_id: "local"` explicitly: omitting the key keeps the remote binding. Never save a machine revision, label, address, or launch or binding fingerprint in metadata. A deleted or restored connection never falls back to This computer; restored addresses need the user’s Reconnect in Settings.
- Agent use is on by default, like any runnable artifact. The badge reads "ComfyUI via Pinokio".
- `icon_ref`: ComfyUI `{ kind: "brand", slug: "comfyui-color" }`, Gradio `{ kind: "brand", slug: "gradio-color" }`, custom `{ kind: "lucide", id: "rocket" }`.

A save checks this and says what to fix. A draft may leave `pinokio_runtime` out; publishing needs it.

## Steps

1. **Choose the computer and find its installed app.** `fabric:sys.pinokio.status` lists the saved computers, even without local Pinokio. Pass the user’s chosen saved computer as `{ "machineId": "<UUID>", "revision": <current revision> }` on remote `search` (plus `query`), `app_status`, `logs` and `run` calls; omit both for This computer. If the serving Pinokio is unavailable, report that computer’s error; never switch a saved target to local. Batshit never installs apps; the user installs a missing app in Pinokio.
2. **Read its API while it runs.** `fabric:sys.pinokio.app_status` with `appId`, the chosen remote target if any, and `describeApi: true`. If it is offline, call `app_status` with `previewStart: true`, then use the returned `startPreview` in `fabric:sys.pinokio.run`: exact `appId`, `machineId`, `revision`, `launchFingerprint` and `alsoStarts`. A preview refusal is a refusal, never an empty dependency list. The normal Approve card is the start consent: add no approval flags and ask for no chat confirmation.
   - **Gradio:** `describeApi` lists named endpoints and parameters in order, each with a name, component, type and default, and returns with a `position`.
   - **ComfyUI:** use the user’s API-format saved workflow. For a local app, `fabric:sys.comfyui.workflows` reads it at the admitted `readyUrl` (`action: "list"`, then `"get"` with `includeWorkflow: true`). Never use a remote native localhost address as a Batshit endpoint or fetch arbitrary remote files. Plan the fields as in `brain-comfyui.md`, then store the API-format node map.
   - **Neither:** a custom API. Ask the user which endpoint to call if its docs are unclear.
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
- The workflow must save its picture (`SaveImage`); each saved image comes back as a file. A ComfyUI recipe takes no image inputs (`LoadImage`) yet.

### Gradio

```json
{
  "api_name": "/predict",
  "inputs": [{ "field": "image", "file": true }, { "field": "prompt" }, { "value": 1024 }],
  "outputs": [1]
}
```

- One entry per endpoint parameter, **in order**, as `describeApi` lists them: a field's value, or a fixed `value` for a parameter the artifact does not expose (use its default). An empty field gets the default the app declares.
- `"file": true` for an image, audio, or file parameter. Its field value is a Clip id (`clip_...`, as the chat's Clips roster lists an attached picture), a public `https` URL, a Batshit Clip URL, or a `data:` URL. Batshit uploads the admitted input’s bytes to the bound app, a saved remote computer included; never pass a Mac file path or an arbitrary private file URL. When you RUN such an artifact for the user, pass the attached Clip's id; do not read the picture yourself instead. A file field is a Builder Kit `form.text` with the `fabricId` (agents pass a URL); in the panel, add a `dropFile` whose file you read as a data URL and pass in `context` under the same `fabricId`.
- `outputs` lists the `position` of each returned value that is the result, in the order to show them. Apps often also return an input preview, a status line or a slider update: leave those out, or every run shares the preview into the chat and repeats the text. If two returns hold the same text (a Markdown view and a raw box), keep one. Left out, all are kept.
- Kept text comes back as `text`, kept images as files (shared into the chat when an agent runs it).

### Custom API

```json
{ "method": "POST", "path": "/api/generate" }
```

Field values go as the JSON body. A JSON answer's `text`, `output`, `result`, or `response` becomes the text (otherwise the whole JSON); an image answer becomes a file.

## When the app is not running

- **An agent run** answers with an error naming `fabric:sys.pinokio.run`. Get the current target-bound start preview and call that control; Batshit shows the Approve card. Preserve `nativeControlOutcome: blocked/cancelled` and `observationEnded: cancelled/timeout` as refusals or ended observations. A remote `alreadyRunning` or native HTTP probe does not prove Batshit can run the recipe: require `endpointReady: true`, or retry the recipe.
- **The panel** offers Start with Pinokio. Batshit’s confirmation names the computer, app and reported `alsoStarts` set. A remote run repeats automatically only once Batshit confirms the endpoint answers. Nothing to build.
- **Pending or unknown:** Pinokio may still own an issued native start. Report it and never blindly send another; check status or retry the recipe. In the panel, Try Again retries the recipe and the iframe sends no other start after an uncertain result; refreshing or reopening gives a fresh preview and confirmation. Closing the panel ends Batshit’s observation, not the remote app.
- **Proven no-send refusal:** a stale preview or binding refused before the native start may get a fresh preview and the normal user confirmation. Never infer no-send from an HTTP status or network error; never automatically retry the launch.
- A changed, deleted, unavailable or restore-inactive computer is a visible error. Never substitute a local app with the same id, retarget a running recipe, or invent a successful start.

## Panels that call the app directly

A custom UI reaches its own saved app on its chosen computer through Batshit's proxy: `window.batshit.pinokio.fetch('<path>', init)` calls `/api/artifacts/pinokio/<path>` (it also offers the start when the app is off). ComfyUI apps allow the ComfyUI paths (`prompt`, `history/<id>`, `view`, `object_info`, `system_stats`, `upload/image`, ...), Gradio apps the Gradio API (`gradio_api/...`), and custom apps any path. Show proxied ComfyUI images with `await window.batshit.resolveMediaUrl(url)`. The iframe receives no remote control socket or bearer. Do not add machine, app-origin or address overrides to the request. Prefer `window.batshit.complete()` unless the panel needs something the recipe cannot do: one code path for the user and agents.

## Raw embed stays the opt-out

If the user only wants the app's own page inside Batshit, use the Gradio embed (`embed-gradio.md`). It is user-only (no fields, no agent use) and needs enforcement switched off. Say so before choosing it.
