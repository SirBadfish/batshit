# ComfyUI Artifact Guide: Build

**Load when:** you have agreed a ComfyUI artifact's fields with the user (`brain-comfyui.md`) and are writing its code: the proxy helper, submit and poll, showing results, and saving. Uploads, model lists, the error table, and endpoints are in `comfyui-reference.md`.

**A Pinokio App artifact (ComfyUI installed in Pinokio) does not use this file's submit and poll.** Batshit's server runs its saved recipe: the panel calls `window.batshit.complete('Run', { context: { <fabricId>: value } })` and shows `result.files`. See `runtime-pinokio.md`.

## There is no `window.batshit.comfyui`

`window.batshit.comfyui` does not exist: no `queuePrompt`, no `getHistory`. Every ComfyUI call goes through Batshit's same-origin proxy at `/api/artifacts/comfyui/...`, never straight to ComfyUI (CORS). Use `window.batshit._fetch(...)` for those calls: it attaches the artifact's runtime token.

## Proxy URL helper

Paste this as real JavaScript (do not escape the backticks or `${...}`; the save refuses a script that does not parse):

```javascript
const COMFY_PROXY = '/api/artifacts/comfyui';
const COMFY_BASE = 'comfyui_api_desktop'; // or 'comfyui_api_standalone', from the user's answer

function comfyUrl(path, params = {}) {
  const url = new URL(`${COMFY_PROXY}/${path.replace(/^\/+/, '')}`, window.location.origin);
  if (COMFY_BASE) url.searchParams.set('baseUrl', COMFY_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
```

## Controls

Build every agreed field with Builder Kit, a `label`, and a `fabricId`, and mount it:

```javascript
const builder = window.batshit.builder;
const promptField = builder.form.textarea({ label: 'Prompt', value: state.prompt, fabricId: 'prompt',
  onChange: (value) => { state.prompt = value; } });
const stepsField = builder.form.slider({ label: 'Steps', min: 1, max: 20, value: state.steps, fabricId: 'steps',
  onChange: (value) => { state.steps = Number(value); } });
builder.mount(document.getElementById('prompt-field'), promptField);
builder.mount(document.getElementById('steps-field'), stepsField);
```

Declare the same IDs in `metadata.fabric_fields` (`{ fabricId: 'prompt', type: 'string', label: 'Prompt', required: true }`, ...). Usually only the prompt is required.

**Read the current values at submit time.** `onChange` keeps state in step while typing, but read each control (`component.input.value`, or query `[data-fabric-id]`) in a small `syncStateFromControls()` at the start of the generate handler, so a missed event or a click while focus is still in a field never submits stale values.

## Inject the values

The API-format workflow you loaded is the template. Deep-clone it and set each exposed field at its `nodeId.inputs.name` path:

```javascript
function injectValues(template, values) {
  const prompt = JSON.parse(JSON.stringify(template));
  // prompt["6"].inputs.text = values.prompt;
  // prompt["5"].inputs.steps = values.steps;
  // prompt["5"].inputs.seed = values.seed === -1 ? Math.floor(Math.random() * 1e15) : values.seed;
  return prompt;
}
```

The node IDs and input names come from the loaded workflow. With a `ui`-format source you still submit API format only.

## Submit and poll

**No default timeout.** Long image and video workflows are normal: keep polling until the job finishes or the user cancels, unless they ask for a limit.

```javascript
function looksLikeApiPrompt(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return Object.values(payload).some((node) => node && typeof node === 'object' && !Array.isArray(node)
    && typeof node.class_type === 'string' && node.inputs && typeof node.inputs === 'object');
}

async function runWorkflow(promptPayload, workflowFormat, onProgress) {
  if (!looksLikeApiPrompt(promptPayload)) {
    throw new Error(workflowFormat === 'ui'
      ? 'This workflow is UI graph format, not API prompt format. Do not submit raw UI workflow JSON to /prompt.'
      : 'Prompt payload is not in ComfyUI API format.');
  }
  const submit = await window.batshit._fetch(comfyUrl('prompt'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: promptPayload, client_id: crypto.randomUUID() }) // the { prompt } wrapper is required
  });
  if (!submit.ok) throw new Error(`Submit failed: ${submit.statusText}`);
  const { prompt_id } = await submit.json();

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const history = await (await window.batshit._fetch(comfyUrl(`history/${prompt_id}`))).json();
    const job = history[prompt_id];
    if (job?.status?.status_str === 'error') throw new Error('ComfyUI generation failed: ' + JSON.stringify(job.status));
    if (job?.status?.completed) {
      for (const output of Object.values(job.outputs || {})) {
        const file = output.images?.[0]; // a video-saving node may use another key: check the job's outputs
        if (file) return comfyUrl('view', { filename: file.filename, subfolder: file.subfolder || '', type: file.type });
      }
      throw new Error('The workflow finished without an output file.');
    }
    if (onProgress) {
      const queue = await (await window.batshit._fetch(comfyUrl('queue'))).json();
      onProgress(`Generating... (${(queue.queue_pending || []).length} ahead in the queue)`);
    }
  }
}
```

**Always show live progress** through `onProgress`: a run takes seconds to many minutes.

## Show the result

An `<img>`, `<video>`, or `<source>` cannot attach the runtime token, so resolve the protected `/view` URL first and keep the original URL for storage and sharing:

```javascript
async function showResult(sourceUrl) {
  const img = document.createElement('img');
  img.src = await window.batshit.resolveMediaUrl(sourceUrl);
  img.alt = 'Generated image';
  document.getElementById('preview').replaceChildren(img);
  window.batshit.storage.set('lastResult', { title: 'ComfyUI generation', data: 'Prompt: ' + state.prompt, image: sourceUrl });
}
```

For a video workflow, build a `<video controls>` the same way; video runs can take 5 to 20+ minutes, so keep the progress line prominent.

Add `builder.action.standardControls({ storageKey: 'lastResult', title: 'ComfyUI generation' })` for Share, Save, and Download.

## Save and publish

Create it in one call: `name`, `content`, `brain_type: "none"`, `metadata` (`source_type: "comfyui"`, `fabric_fields`), `icon_ref: { kind: "brand", slug: "comfyui-color" }`, `agent_use_enabled: false`, `zone: "panel"`, and `mode: "published"`. If the save is refused, fix what it lists and resend.

Then ask the user to open it and run one generation with ComfyUI running. It is a user-run panel artifact: there is no agent run to test and no agent access to set up. Tell them where it is and that ComfyUI must be open when they use it.
