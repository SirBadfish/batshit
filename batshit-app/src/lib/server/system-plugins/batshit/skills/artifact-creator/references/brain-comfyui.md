# ComfyUI Artifact Guide: Plan

**Load when:** the user wants one of their existing, working ComfyUI workflows turned into an artifact. This part covers readiness, finding and reading the workflow, and agreeing the fields with the user. Then load `comfyui-build.md` to write it, and `comfyui-reference.md` for uploads, model lists, errors, and endpoints.

**ComfyUI installed in Pinokio?** (The user says so, or `sys.pinokio.search` lists it.) Then it is a **Pinokio App** artifact, not this contract: `brain_type: "pinokio_app"`, agent use ON. Load `runtime-pinokio.md` and follow it; use this file only for Steps 2-4 (reading the workflow and planning the fields), and skip `comfyui-build.md`.

## The contract, decided before you read the workflow

- The UI is **Builder Kit**: every main control is `window.batshit.builder.form.*`, mounted with `builder.mount(...)`, with a `label` and a `fabricId`. No hand-rolled `<input>`, `<select>`, `<textarea>`, or range sliders.
- `metadata.fabric_fields` declares every `fabricId` (or `metadata.run_only: true` for a no-input trigger).
- `metadata.source_type: "comfyui"`, `brain_type: "none"`, `icon_ref: { kind: "brand", slug: "comfyui-color" }`.
- **`agent_use_enabled: false`.** ComfyUI panel artifacts are user-run: Batshit has no backend ComfyUI runner, so agents cannot run them. Do not ask the user whether agents should use it. If they want an agent-runnable path, explain that it needs a future backend runner or a custom webhook artifact.
- Results get `standardControls()`; no title or generic description at the top.

The mapping is always: workflow setting -> Builder Kit control -> `fabricId` -> `metadata.fabric_fields` entry.

## Is the user ready?

They need ComfyUI installed and running (the Desktop app or the standalone browser version) and at least one saved workflow that already does what they want. If either is missing, stop the artifact build: help them get ComfyUI running or find a workflow as a separate conversation, and say "once you have a workflow that works the way you want, we can turn it into an artifact." **Never generate ComfyUI workflows from scratch for an artifact**: the point is to wrap one they already like.

## Step 1: Their setup

Ask: *"Are you using the ComfyUI Desktop app, or the standalone browser version?"* (The Desktop app installs like a normal application; the standalone one runs from a terminal and opens in a browser.)

| Version | Usual URL | Runtime alias in artifact code |
|---|---|---|
| Desktop app | `http://127.0.0.1:8000` | `comfyui_api_desktop` |
| Standalone | `http://127.0.0.1:8188` | `comfyui_api_standalone` |

Batshit's proxy resolves the alias, so the artifact never hardcodes a `localhost` URL. Tell them ComfyUI must be running whenever they use the artifact. If Batshit runs in Docker, load `runtime-location.md` first.

## Step 2: Find and load the workflow

List their saved workflows with the ComfyUI workflow control your lane has (in-app: search `family: "fabric"` for `sys.comfyui.workflows`). A portable agent without it asks the user to name the workflow or export it safely. Match the name to what they described ("my Flux turbo workflow"); if unsure, show just the names and ask which one.

Load it with `action: "get"`, `workflowName` (the exact filename), and `includeWorkflow: true`. Never ask the user to paste workflow JSON.

### Read `workflow_format` before anything else

- `"api"`: a prompt-ready node map (`{ "3": { "class_type": "...", "inputs": { } } }`); safe to submit after you inject values.
- `"ui"`: the editor graph (`nodes`, `links`, `definitions`): for analysis only, **never** a `/prompt` payload.

The proxy's `/prompt` body must be `{ "prompt": <api node map>, "client_id": "<optional uuid>" }`. Never POST the node map by itself, and never the raw UI graph. With only a `ui` workflow, plan the fields from it, then load or export an API-format version (or write an explicit converter) before any submit code. If neither is possible, stop and explain; do not ship code that "tries anyway" and fails with opaque 500s.

## Step 3: Read the workflow and talk it through

The paths below are API prompt paths (`nodeId.inputs.field`). Look for user-facing settings:

| Setting | Where | In plain words |
|---|---|---|
| Prompt | `CLIPTextEncode` -> `inputs.text` | What the picture should show |
| Negative prompt | second `CLIPTextEncode` (only if wired to the sampler's `negative`) | What to avoid |
| Steps | `KSampler` -> `inputs.steps` | Refinement passes: more is better but slower |
| CFG | `KSampler` -> `inputs.cfg` | How literally it follows the prompt |
| Sampler / Scheduler | `KSampler` -> `inputs.sampler_name` / `inputs.scheduler` | The generation method and its pacing |
| Seed | `KSampler` -> `inputs.seed` | Same seed, same picture |
| Width / Height | `EmptyLatentImage` -> `inputs.width` / `.height` | Picture size |
| Denoise | `KSampler` -> `inputs.denoise` | How much to change an input picture (1.0 replaces it) |
| Model | `CheckpointLoaderSimple` -> `inputs.ckpt_name` | Which model |
| LoRA strength | `LoraLoader` -> `inputs.model_strength` | How strongly a style or character LoRA applies |
| ControlNet strength | `ControlNetApplyAdvanced` -> `inputs.strength` | How closely it follows a reference's structure |

Ignore the wiring between nodes (`model`, `clip`, `vae`, `latent_image`, `positive`, `negative`, `samples`, `images`).

Tell the user what you found and recommend what to expose, in plain words. For example: *"It's a Flux text-to-image workflow with a prompt, 20 steps, 1024x1024, the euler sampler, the simple scheduler, and a seed. I'd put the prompt, steps, and image size in the artifact, and leave the sampler and scheduler as they are (both are the standard Flux choice). I can add a randomize-seed switch. Want any of the others adjustable?"* Explain any term they don't know in one sentence, so they can choose without becoming a ComfyUI expert.

If you need a field's allowed values (the installed samplers, say), use the ComfyUI object-info control with `includeSchema: true` and `classTypes` limited to this workflow's node types. **Never fetch the full `/object_info`**: on a big install it is enormous. The workflow JSON usually has enough.

## Step 4: Confirm the plan

Settle the exact field list with the user. Agent use stays off (`agent_use_enabled: false`); keep `metadata.fabric_fields` anyway for the Builder Kit contract and a future backend runner. Design the defaults so the prompt alone gives a good result.

Zone: **panel** (the form plus a large result). A one-click workflow with no controls can use **trigger** with `metadata.run_only: true`.

Next: load `comfyui-build.md`.
