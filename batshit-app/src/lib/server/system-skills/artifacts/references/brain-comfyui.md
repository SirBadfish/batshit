# ComfyUI Artifact Builder Guide

You are helping a user turn their **existing, working ComfyUI workflow** into a polished Batshit artifact — a persistent mini-app with a clean UI that lives in their workspace. This guide walks you through the entire process step by step.

## Step 0: Builder Kit Contract (Mandatory Before Workflow Analysis)

Batshit now enforces artifact structure at save time unless the user manually turned that toggle off for this artifact in Settings -> Artifacts.

- Use **Builder Kit** for the UI
- Declare a **Fabric runtime contract** (`metadata.fabric_fields` or `metadata.run_only=true`)
- Make sure the HTML includes matching `fabricId` bindings for every declared field
- Set `icon_ref` to `{ kind: "brand", slug: "comfyui-color" }` and `metadata.source_type` to `comfyui`
- Set `agent_use_enabled` to `false`. ComfyUI panel artifacts are user-run for now; agents cannot discover them as `artifact:` refs through Dynamic Tool Search unless you build a separate backend Batshit runtime, such as a custom webhook.

If you skip those pieces, the artifact will not save.

Also: run `sys.artifact.validate_structure` before every save or publish pass so you catch drift early when you revise the artifact later.

Treat this as a hard gate, not as background context. Before you inspect the workflow in detail or write any artifact HTML:

1. Decide which user-facing fields will exist.
2. Map every field to a Builder Kit control.
3. Pick the matching `fabricId` names.
4. Plan DOM mount points and use `window.batshit.builder.mount(target, component)`.
5. Plan the matching `metadata.fabric_fields` entries.
6. Start the artifact body with the form/results, not a repeated ComfyUI title or generic description.
7. Only then start building.

### Pre-Build Mental Checklist

- [ ] I will use `window.batshit.builder.form.*` for every main user control.
- [ ] I will mount Builder Kit controls with `window.batshit.builder.mount(...)`.
- [ ] I will not hand-roll `<input>`, `<select>`, `<textarea>`, or range sliders for the primary artifact UI.
- [ ] Every user-facing control will have a matching `fabricId`.
- [ ] Every `fabricId` will be declared in `metadata.fabric_fields`, unless this is truly `run_only`.
- [ ] The create/update payload will include `metadata.source_type: 'comfyui'` and a ComfyUI `icon_ref`.
- [ ] The create/update payload will include `agent_use_enabled: false` for this panel-side ComfyUI artifact.
- [ ] I will include `standardControls()` unless this artifact is truly trigger-only.
- [ ] I will not render the artifact title or a generic description at the top of the artifact body.
- [ ] I will run `sys.artifact.validate_structure` before the first save/publish pass.

If you are tempted to "just get the UI working first" with raw HTML controls, stop. That path is what enforcement is designed to reject.

### Builder Kit Pattern for ComfyUI Artifacts

Every ComfyUI artifact should follow this pattern:

```javascript
// 1. Add empty mount points in the HTML
<div id="prompt-field"></div>
<div id="steps-field"></div>
<div id="lora1-name-field"></div>

// 2. Build controls with Builder Kit + fabricId
const promptField = window.batshit.builder.form.textarea({
  label: 'Prompt',
  value: state.prompt,
  fabricId: 'prompt',
  onChange: (value) => { state.prompt = value; }
});

const stepsField = window.batshit.builder.form.slider({
  label: 'Steps',
  min: 1,
  max: 20,
  value: state.steps,
  fabricId: 'steps',
  onChange: (value) => { state.steps = Number(value); }
});

// 3. Mount them into the DOM
window.batshit.builder.mount(document.getElementById('prompt-field'), promptField);
window.batshit.builder.mount(document.getElementById('steps-field'), stepsField);

// 4. Declare matching metadata.fabric_fields
metadata.fabric_fields = [
  { fabricId: 'prompt', type: 'string', label: 'Prompt', required: true },
  { fabricId: 'steps', type: 'number', label: 'Steps', required: false }
];
```

The pattern is always:
1. Container divs
2. `window.batshit.builder.form.*` controls
3. `fabricId` on each user-facing field
4. `builder.mount(...)`
5. Matching `metadata.fabric_fields`

### Wrong vs Right

**Wrong:**

```html
<!-- Enforcement-on artifacts should not do this for the main UI -->
<textarea id="prompt"></textarea>
<input type="range" id="steps" min="1" max="20" value="8">
<select id="lora1-name"></select>
```

**Right:**

```javascript
const promptField = window.batshit.builder.form.textarea({
  label: 'Prompt',
  fabricId: 'prompt',
  onChange: (value) => { state.prompt = value; }
});
```

---

## Prerequisites — Is the User Ready?

Before you start the artifact building process, the user MUST have:

1. **ComfyUI installed and running** (either the Desktop app or the standalone browser version)
2. **At least one working workflow** saved in ComfyUI that does what they want

**If either prerequisite is missing, STOP.** The artifact building process is not the right next step yet. Instead:
- Help the user get ComfyUI installed and running, or help them build/find a workflow that does what they need — but that's a separate conversation, not the artifact skill
- Let them know: "Once you have ComfyUI running with a workflow that works the way you want, we can turn it into a Batshit artifact with a nice UI. Come back when you're ready!"
- You can absolutely help them learn ComfyUI, troubleshoot their setup, find models, etc. — but that's general assistance, not the artifact build process

**Do NOT try to generate ComfyUI workflows from scratch** as part of artifact building. The whole point is to wrap an existing workflow the user already has and likes.

---

## Step 1: Understand the User's Setup

When the user says something like "turn my ComfyUI workflow into an artifact" or "make an artifact for my Flux workflow":

### Ask Which Version They Use

Most people in 2026 use the **ComfyUI Desktop app** (Mac/Windows), not the standalone Python/browser version. But you need to know because the API URL is different:

- **Desktop app**: typically `http://127.0.0.1:8000`
- **Standalone (Python/browser)**: typically `http://127.0.0.1:8188`

Ask them: *"Are you using the ComfyUI Desktop app, or the standalone browser version?"*

If they're not sure, the Desktop app is the one they downloaded and installed like a regular application. The standalone version is the one they run from a terminal/command line and open in their browser.

### Confirm ComfyUI Is Running

The artifact will talk to ComfyUI's API in the background, so ComfyUI needs to be open and running when they use it. Just make sure they know: *"ComfyUI needs to be running in the background whenever you use this artifact."*

### Set the URL Alias

Based on their answer, you'll use one of these runtime aliases in the artifact code:
- Desktop app → `comfyui_api_desktop`
- Standalone → `comfyui_api_standalone`

These aliases are resolved by Batshit's proxy so the artifact never needs to hardcode `localhost` URLs.

---

## Step 2: Find and Load the Workflow

Now find the specific workflow the user wants to turn into an artifact.

### List Their Workflows

Use the ComfyUI workflow inspection method available in your current lane to list saved workflows. In-app agents may have Batshit ComfyUI Fabric controls. Portable agents may not have those controls through the Artifact token, so they should use their own outside-agent tools, ask the user to identify the workflow, or ask for a safe exported workflow file.

Look through the list and find the one that matches what the user described. For example, if they said "my Flux turbo workflow," look for something with "flux" and "turbo" in the name.

If you're not sure which one, show them the list (just the names, keep it clean) and ask: *"Which of these is the one you'd like to turn into an artifact?"*

### Load the Workflow

Once you know which one, load it through the available ComfyUI workflow control or user-provided export with:
- `action: "get"`
- `workflowName`: the exact filename
- `includeWorkflow: true`

This gives you the full workflow JSON — the complete node graph with all the settings.

**Never ask the user to copy-paste workflow JSON.** The API handles this for you.

### ⚠️ CRITICAL: Check `workflow_format` Before You Build

`fabric:sys.comfyui.workflows` returns `workflow_format` in its result. You MUST read it before writing runtime code.

- `workflow_format: "api"` → prompt-ready payload shape for `/prompt` (safe to submit after value injection)
- `workflow_format: "ui"` → editor graph shape (`nodes`, `links`, `definitions`, etc.) used for analysis/planning, **not** valid direct `/prompt` payload

**Hard submit rule:** Batshit's ComfyUI proxy expects the runtime request body to be:

```json
{
  "prompt": { "3": { "class_type": "...", "inputs": { } } },
  "client_id": "optional-uuid"
}
```

Do **not** submit the API node map by itself.
Do **not** submit the raw UI graph.
The top-level `"prompt"` wrapper is required.

If you only have `ui` format:
- You can still inspect fields and build the artifact UI
- But do NOT submit the raw UI graph to `/prompt`
- Either (1) load/export an API-format version of the workflow, or (2) implement an explicit converter to API prompt format before runtime submit

If no converter/API-format path is available, **stop and explain clearly**. Do not ship code that "tries anyway" and produces opaque 500 errors.

---

## Step 3: Analyze the Workflow and Talk It Through

This is the most important step. Read the workflow JSON and figure out what settings exist, then have a conversation about what should go in the artifact UI.

Before you turn any workflow finding into UI code, map it through the Step 0 contract first:
- workflow field -> Builder Kit primitive
- Builder Kit primitive -> `fabricId`
- `fabricId` -> `metadata.fabric_fields`

### What to Look For

The field paths in this section are API prompt paths (`nodeId.inputs.fieldName` style). If your source workflow is `ui` format, use it for planning and mapping, then convert/build into API prompt format for runtime execution.

Scan the workflow nodes for user-facing settings. Common ones:

| Setting | Where to Find It | What It Does (plain language) |
|---|---|---|
| Prompt (positive) | `CLIPTextEncode` node → `inputs.text` | What the user wants to see in the image |
| Negative prompt | Second `CLIPTextEncode` → `inputs.text` (only if wired to sampler `negative`) | What to avoid in the image |
| Steps | `KSampler` → `inputs.steps` | How many refinement passes — more = better quality but slower |
| CFG scale | `KSampler` → `inputs.cfg` | How closely to follow the prompt — higher = more literal |
| Sampler | `KSampler` → `inputs.sampler_name` | The algorithm used for generation |
| Scheduler | `KSampler` → `inputs.scheduler` | Controls how the sampler progresses through steps |
| Seed | `KSampler` → `inputs.seed` | Random seed — same seed = same image |
| Width / Height | `EmptyLatentImage` → `inputs.width / .height` | Image dimensions |
| Denoise | `KSampler` → `inputs.denoise` | How much to change (for img2img — 1.0 = full replacement) |
| Model | `CheckpointLoaderSimple` → `inputs.ckpt_name` | Which AI model to use |
| LoRA strength | `LoraLoader` → `inputs.model_strength` | How strongly to apply a style/character LoRA |
| ControlNet strength | `ControlNetApplyAdvanced` → `inputs.strength` | How closely to follow a reference image's structure |

**Ignore internal wiring** — things like `model`, `clip`, `vae`, `latent_image`, `positive`, `negative`, `samples`, `images` connections between nodes. Those are plumbing, not user settings.

### Present Your Findings in Plain Language

Tell the user what you found. Something like:

> *"OK, I found your workflow! It's a Flux text-to-image setup. Here's what I see:*
>
> *It has settings for: prompt, steps (currently set to 20), image size (1024x1024), sampler (euler), and scheduler (simple). There's also a seed setting.*
>
> ***I'd recommend exposing these in the artifact UI:***
> - *Prompt (obviously — this is what you type to describe your image)*
> - *Steps (lets you trade off speed vs quality)*
> - *Image size (width and height)*
>
> ***These could stay as-is since you probably don't change them often:***
> - *Sampler (currently euler — that's a good default for Flux)*
> - *Scheduler (currently simple — also the standard for Flux)*
> - *Seed (we can include a "randomize" toggle if you want, or just auto-randomize)*
>
> *What do you think? Want any of those 'stay as-is' settings to be adjustable too?"*

### Explain Anything They Don't Understand

If the user doesn't know what a scheduler is, explain it simply: *"The scheduler controls how the generation progresses through its steps. Yours is set to 'simple' which is the standard choice for Flux. Since you're not really tweaking that, we can just leave it locked in. You won't even see it in the artifact."*

The goal is for them to make an informed choice about what belongs in their UI without needing to become a ComfyUI expert.

### Optional: Schema Precision Check

If you need more detail about what values a field accepts (like which samplers are available), use the available ComfyUI object-info route/control and:
- `includeSchema: true`
- `classTypes`: limited to the specific node types from this workflow (e.g., `["KSampler", "CheckpointLoaderSimple"]`)

**Do NOT fetch the full unfiltered `/object_info`.** On a mature ComfyUI install with lots of custom nodes, that response can be enormous. Always filter by the class types in the workflow.

Only use this when you genuinely need to know field constraints (like dropdown options). The workflow JSON itself usually has enough info.

---

## Step 4: Confirm the Plan

Once you've discussed the settings, confirm the final plan before building. You need two things:

### 1. The Field List

Confirm exactly which settings will be in the artifact UI. This should be settled from Step 3.

### 2. Agent Use (Fabric)

ComfyUI panel artifacts are user-run for now. Do not ask whether agents should use this artifact as a tool, and do not set `agent_use_enabled: true`.

- Set `agent_use_enabled: false`
- Keep `metadata.fabric_fields` for Builder Kit structure, field tracking, and future/backend readiness
- If the user asks for an agent-runnable ComfyUI path, explain that current panel-side ComfyUI artifacts cannot be run by agents yet; a future backend ComfyUI runner or a custom webhook artifact would be needed

---

## Step 5: Build the Artifact

Now you have everything you need. Build it.

### ⚠️ CRITICAL: There Are No ComfyUI Helpers on `window.batshit`

**`window.batshit.comfyui` does NOT exist.** There is no `window.batshit.comfyui.queuePrompt`, no `window.batshit.comfyui.getHistory`, no `window.batshit.comfyui.anything`. These methods do not exist and will silently fail.

**ALL ComfyUI API calls use Batshit's same-origin proxy.** Your artifact code talks to `/api/artifacts/comfyui/...`; never call ComfyUI directly from the browser. Batshit's artifact runtime automatically attaches the sandbox token for same-origin artifact API calls, and `window.batshit._fetch(...)` is the clearest explicit form when you are writing new code.

### Proxy URL Pattern

Use this helper in the artifact code to build proxy URLs:

```javascript
const COMFY_PROXY = '/api/artifacts/comfyui';
const COMFY_BASE = 'comfyui_api_desktop'; // or 'comfyui_api_standalone'

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

Paste this helper as real JavaScript. Do not escape the backticks or `${...}` interpolation inside the artifact `<script>` block; `sys.artifact.validate_structure` will block syntax-broken inline scripts and warn about escaped template interpolation.

When calling proxy URLs, prefer `window.batshit._fetch(comfyUrl(...), options)` over bare `fetch(...)`. Bare same-origin artifact API fetches are runtime-authenticated automatically, but `_fetch` makes the intended Batshit API call explicit.

Set `COMFY_BASE` based on what the user told you in Step 1.

### Read Current Control Values at Submit Time

Builder Kit `onChange` handlers keep state in sync during normal typing, but ComfyUI artifacts must still read the current form values immediately before building the prompt payload. This prevents stale default values if a browser event is missed or the user clicks Generate while focus is still inside a control.

Keep references to your Builder Kit components or query by `data-fabric-id`, then run a small `syncStateFromControls()` function at the start of the generate handler before building workflow JSON.

### Generation Flow

The artifact runs this cycle: User fills form → build workflow JSON → submit → poll → display result.

**Timeout rule:** Do not add a default generation timeout for ComfyUI artifacts. Long-running workflows are normal here, especially for video or heavy image pipelines. Keep polling until completion unless the user explicitly asks for a timeout or cancel window.

```javascript
function looksLikeApiPrompt(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  // API prompt objects are node maps: { "3": { class_type, inputs }, ... }
  const entries = Object.entries(payload);
  if (entries.length === 0) return false;
  return entries.some(([_, node]) =>
    node &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    typeof node.class_type === 'string' &&
    node.inputs &&
    typeof node.inputs === 'object'
  );
}

function assertPromptReady(promptPayload, workflowFormat) {
  if (!looksLikeApiPrompt(promptPayload)) {
    throw new Error(
      workflowFormat === 'ui'
        ? 'This workflow is UI graph format, not API prompt format. Do not submit raw UI workflow JSON to /prompt.'
        : 'Prompt payload is not in ComfyUI API format. Build/convert to API prompt node map before submit.'
    );
  }
}

async function runWorkflow(promptPayload, workflowFormat, onProgress) {
  assertPromptReady(promptPayload, workflowFormat);
  const clientId = crypto.randomUUID();

  // 1. Submit to ComfyUI queue
  // IMPORTANT: /prompt requires the top-level { prompt: ... } wrapper.
  const submitRes = await window.batshit._fetch(comfyUrl('prompt'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: promptPayload, client_id: clientId })
  });
  if (!submitRes.ok) throw new Error(`Submit failed: ${submitRes.statusText}`);
  const { prompt_id } = await submitRes.json();

  // 2. Poll for completion (check every 2 seconds, no default timeout)
  const pollIntervalMs = 2000;
  for (;;) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const historyRes = await window.batshit._fetch(comfyUrl(`history/${prompt_id}`));
    const history = await historyRes.json();
    const job = history[prompt_id];

    if (!job) continue;

    if (job.status?.status_str === 'error') {
      throw new Error('ComfyUI generation failed: ' + JSON.stringify(job.status));
    }

    if (job.status?.completed) {
      // 3. Get the output image
      for (const output of Object.values(job.outputs || {})) {
        if (output.images?.length > 0) {
          const img = output.images[0];
          return comfyUrl('view', {
            filename: img.filename,
            subfolder: img.subfolder || '',
            type: img.type
          });
        }
      }
    }

    if (onProgress) {
      const queueRes = await window.batshit._fetch(comfyUrl('queue'));
      const queue = await queueRes.json();
      const pending = (queue.queue_pending || []).length;
      onProgress(`Generating... (queue: ${pending} ahead)`);
    }
  }

}
```

When displaying the returned `/view` URL in the panel, do not assign the protected proxy URL directly to an `<img>`/`<video>`/`<source>` if you can avoid it. Those element loads cannot attach the artifact runtime token themselves. Resolve the media first and keep the original ComfyUI proxy URL for storage/share payloads:

```javascript
async function showResultImage(sourceUrl) {
  const displayUrl = await window.batshit.resolveMediaUrl(sourceUrl);
  const img = document.createElement('img');
  img.src = displayUrl;
  img.alt = 'Generated image';
  document.getElementById('preview').replaceChildren(img);
}
```

### Injecting User Values into the Workflow

The workflow JSON you loaded in Step 2 is your template. Before submitting, replace values for the fields the user chose to expose.

**Important:** this injection example assumes API prompt format.

```javascript
function injectUserValuesApiPrompt(promptJson, userValues) {
  // Deep clone so we don't mutate the template
  const prompt = JSON.parse(JSON.stringify(promptJson));

  // For each user-facing field, find the right node and set the value
  // Example: if the user has a "steps" control mapped to node "5", input "steps":
  // prompt["5"].inputs.steps = userValues.steps;

  // Randomize seed if user wants random
  // prompt["5"].inputs.seed = userValues.seed === -1
  //   ? Math.floor(Math.random() * 1e15)
  //   : userValues.seed;

  return prompt;
}
```

The exact node IDs and input names come from the workflow JSON you loaded. Map each user-facing control to its `nodeId.inputs.inputName` path.

If your source workflow is `ui` format, you still use it to discover what users should control — but runtime submission must use API prompt format. Never POST the raw UI graph object to `/prompt`.

### Standard Action Controls

Always include share/save/download buttons using the builder kit:

```javascript
// After a successful generation, store the result and show action buttons
window.batshit.storage.set('lastResult', {
  title: 'ComfyUI Generation',
  data: `Generated with prompt: "${promptValue.slice(0, 80)}..."`,
  image: imageUrl
});
```

Use `window.batshit.builder.action.standardControls()` so the user gets consistent share/save/download behavior across all their artifacts.

### Fabric Fields (for Agent Use)

Build `metadata.fabric_fields` from the confirmed field list whether agent use is ON or OFF. Each field needs:
- `fabricId`: matches the field name (e.g., `prompt`, `steps`, `width`)
- `type`: `string`, `number`, etc.
- `label`: human-readable name
- `required`: whether agents must provide it (usually just `prompt` is required; everything else has defaults)

Design it so an agent only needs to send a prompt to get a good result. Everything else should have sensible defaults from the workflow.

### Progress Display

**Always show live progress.** Generation can take 10 seconds to several minutes depending on the workflow and hardware. The user (and agents) need to know something is happening. Use the `onProgress` callback in `runWorkflow` to update a status message.

### Zone

ComfyUI artifacts go in the `panel` zone. They need space for the form controls and the output image/video.

One-click trigger-only workflows (no UI controls, just "run it") can use the `trigger` zone — and should set `metadata.run_only: true` in addition to zone selection.

---

## Uploading Input Images

For workflows that take an input image (img2img, ControlNet, inpainting):

```javascript
async function uploadImage(imageFile) {
  const formData = new FormData();
  formData.append('image', imageFile);
  formData.append('type', 'input');
  formData.append('overwrite', 'true');

  const res = await window.batshit._fetch(comfyUrl('upload/image'), {
    method: 'POST',
    body: formData
  });
  const { name } = await res.json();
  return name; // Use this filename in LoadImage node: inputs.image = name
}
```

Then set the `LoadImage` node's input in the workflow JSON:
```javascript
workflow["LoadImageNodeId"].inputs.image = uploadedFilename;
```

---

## Querying Available Models

If you need to populate a model selector with the user's installed models:

```javascript
const checkpoints = await window.batshit._fetch(comfyUrl('models/checkpoints')).then(r => r.json());
const loras = await window.batshit._fetch(comfyUrl('models/loras')).then(r => r.json());
const stats = await window.batshit._fetch(comfyUrl('system_stats')).then(r => r.json());
```

Use this instead of hardcoding model names — every user's install is different.

---

## Queue Management

If a job gets stuck or the user wants to cancel:

```javascript
async function cancelQueue() {
  await window.batshit._fetch(comfyUrl('interrupt'), { method: 'POST' });
  await window.batshit._fetch(comfyUrl('queue'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true })
  });
}
```

---

## Error Handling

| Error | What Happened | What to Do |
|---|---|---|
| `Failed to fetch` / network error | ComfyUI isn't running, or the proxy URL is wrong | Check that ComfyUI is open and running. Verify the right base URL (desktop vs standalone). |
| `400` with `missing_prompt_field` | Runtime code sent the wrong `/prompt` request body shape | Make sure the fetch body is `JSON.stringify({ prompt: promptPayload, client_id })`. Do not send the node map raw. |
| `400` with `ui_workflow_not_prompt` | UI workflow graph was submitted to `/prompt` | Check `workflow_format`. If it's `ui`, convert/export to API prompt format before submit. |
| `500 Internal Server Error` immediately after `/prompt` submit | Most commonly: UI workflow graph was submitted as `prompt` instead of API prompt format | Check `workflow_format` from the `fabric:sys.comfyui.workflows` result. If it's `ui`, do not submit directly — load/convert to API prompt format first. |
| `error` status in history | Something went wrong in the workflow — usually a missing model or bad input | Show the error to the user. Check ComfyUI's own console for details. |
| Model not found | The checkpoint or LoRA file isn't in the right folder | Guide user to download the model to `ComfyUI/models/checkpoints/` (or `loras/`, etc.) |
| Custom node missing | A required node pack isn't installed | Guide user to open ComfyUI → Manager → Install Custom Nodes → search by name |
| VRAM / memory error | GPU ran out of memory | Suggest reducing resolution, steps, or batch size. On Mac, try `--lowvram` flag. |
| Job stuck (not completing) | Queue is hung from a previous failure | Use the cancel helper above to clear the queue and try again |
| Generation appears to run forever | Very slow hardware, very demanding workflow, or no useful progress display | Keep polling unless the user explicitly wants a timeout. Improve progress messaging and offer a manual cancel action if helpful. |

---

## Model-Specific Defaults

When reviewing the user's workflow, these are the standard defaults by model family. Use these to know what's "normal" vs. what the user has customized:

| Parameter | SD 1.5 | SDXL | Flux (dev) | Flux (schnell) |
|---|---|---|---|---|
| Steps | 20-30 | 25-35 | 20-28 | 1-4 |
| CFG | 7.0 | 7.0 | **1.0** | **1.0** |
| Sampler | euler_a | dpmpp_2m | euler | euler |
| Scheduler | karras | karras | simple | simple |
| Negative prompt | Yes | Yes | **No** | **No** |
| Best resolution | 512-768px | 1024px | 1024px | 1024px |

**Important model notes:**
- **Flux** does NOT use negative prompts and CFG must be 1.0. If the user's Flux workflow has these, they're being ignored.
- **SD 1.5** works best at 512-768px. Going larger without upscaling produces worse results.
- **SDXL** is optimized for 1024px. Common aspect ratios: 1024x1024, 1152x896, 896x1152.

### Common Resolution Presets

| Format | SD 1.5 | SDXL / Flux |
|---|---|---|
| Square | 512x512 | 1024x1024 |
| Portrait | 512x768 | 896x1152 |
| Landscape | 768x512 | 1152x896 |
| Widescreen | 768x432 | 1344x768 |

---

## Video Workflows (Wan 2.1)

If the user's workflow generates video (Wan 2.1 or similar), the output handling is different:

```javascript
// Videos come back as video files, not images
const videoUrl = comfyUrl('view', { filename, type: 'output' });
output.innerHTML = `<video src="${videoUrl}" controls style="max-width:100%"></video>`;
```

**Video generation is slow** — 5 to 20+ minutes even on good hardware. Make sure the progress display is prominent and the timeout is generous.

---

## ComfyUI API Endpoints Reference

| Endpoint | Method | What It Does |
|---|---|---|
| `/prompt` | POST | Submit an **API prompt-format** workflow object to the queue, returns `prompt_id` |
| `/history/{prompt_id}` | GET | Check if a job is done and get output filenames |
| `/view` | GET | Get the generated image/video by filename |
| `/upload/image` | POST | Upload an input image (for img2img, ControlNet, etc.) |
| `/queue` | GET/POST | View or clear the generation queue |
| `/interrupt` | POST | Stop the current job |
| `/userdata?dir=workflows` | GET | List saved workflow filenames |
| `/userdata/workflows%2F<name>.json` | GET | Fetch a saved workflow's JSON |
| `/object_info` | GET | Node schema lookup (use targeted, never full dump) |
| `/models/{folder}` | GET | List available models in a folder |
| `/system_stats` | GET | GPU/CPU/VRAM info |

All of these are accessed through Batshit's proxy at `/api/artifacts/comfyui/...` using `window.batshit._fetch(...)` or same-origin `fetch(...)` from inside the artifact — never call ComfyUI directly (CORS) and never use `window.batshit.comfyui.*` (doesn't exist).

---

## Final Step: Agent Access and Publishing

Your artifact is built and configured. Now load the `fabric-and-agent-use` reference, set up agent access, **publish it yourself**, and then re-test the published runtime.

Load `references/fabric-and-agent-use.md`. It walks you through asking the user about agent access, configuring Fabric fields, testing, and publishing.
