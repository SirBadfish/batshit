---
name: "artifact-creator"
description: "Build, configure, and publish persistent mini-app artifacts in Batshit."
license: "Proprietary (Batshit system skill)"
compatibility: "batshit-prelaunch"
metadata: {"system":"true","domain":"artifacts","command":"/artifact-creator","mcp_scope_mode":"replace","mcp_scope_gateways":"all","displayName":"Artifact Creator","allowedTools":"native_batshit_tool_search,native_batshit_tool_use,native_skill","trust":"trusted"}
---

# Artifact Creator (Batshit System Skill)

A Batshit-owned **system skill**: it cannot be edited in place. If a user wants a customized variant, create a copy.

You build artifacts: persistent mini-apps (HTML/CSS/JS) that live in the user's workspace zones, can call AI, and can become agent tools. This file has what every build needs. The references hold the rest, and each one opens with a **Load when** line. Load only the references the current step needs, with `native_skill` (`action: "read"`); each fits in one read, so read it once.

## What Batshit checks on every save

`sys.artifact.create`, `update`, `apply_patch`, `publish`, `add_version`, and `rollback` all run the same checks and refuse with a list of what to fix. While **Enforce Batshit Artifact Structure** is on (the default):

- The HTML uses **Builder Kit** (`window.batshit.builder.*`).
- The artifact declares a **Fabric runtime contract**: `metadata.fabric_fields`, or `metadata.run_only: true` for a trigger with no inputs.
- Every declared field has a matching `fabricId` in the HTML.
- Every field has a **name a screen reader can read**: Builder Kit fields take `label` (or `ariaLabel` when they show no label); a hand-written `<input>`, `<select>`, or `<textarea>` needs a linked `<label for>`, a wrapping `<label>`, or `aria-label`. A placeholder is not a name.
- Inline scripts parse (always checked, even with enforcement off).

A refused save names each problem: fix those and send the save again. You do not need a separate check first. `sys.artifact.validate_structure` gives the same verdict without saving; use it to dry-run a risky edit.

Only the user can switch enforcement off, per artifact, in Settings -> Artifacts. A raw embed needs that first. Never promise to bypass it from chat.

## Before you write code

1. **Zone:** panel, header, or trigger (table below).
2. **Result or trigger?** A result artifact gets `builder.action.standardControls()` (Share to Chat, Save to Clip Vault, Download). A trigger with no inputs sets `metadata.run_only: true`.
3. **Fields:** write the list first (`prompt`, `bill-amount`, `tip-percent`, ...).
4. **Builder Kit mapping:** text or prompt -> `form.text()` / `form.textarea()`; dropdown -> `form.select()`; a number the user types or must hit exactly -> `form.number()`; a rough range -> `form.slider()` (it shows its value); on/off -> `form.checkbox()`. Every field gets a visible `label`. Skip Builder Kit only for a user-only Gradio/HuggingFace embed.
5. **Mounting and values:** `window.batshit.builder.mount(container, component)`; read values from `onChange` or `component.input.value` / `.checked`.
6. **`fabricId` names:** clear and unique, matched in `metadata.fabric_fields` (`{ fabricId, type, label }`). Never `model`, `mode`, `context`, `sessionId`, or `webhook_url`: the agent's run call keeps those names, so a save refuses them (use `model_name`). n8n: the exact `$json.body.*` keys. Image generators: `source-image-1-url`, `image-count`, `aspect-ratio`, `resolution`.
7. **Power source and model** (tables below). Built-in AI needs an exact model before it can run, and a `system_prompt` with its standing instructions (an agent's run sends only field values).
8. **Body:** start with the controls or result. Do not repeat the artifact name as a title (Batshit draws it); add a short note only for required instructions or a user request.

Raw `<input>`/`<select>`/`<textarea>` as the main controls is the wrong reflex: switch back to Builder Kit.

## Power source

Pick it yourself and say it in product words ("I'll set this up as Built-in AI"). Never ask for a "brain type".

| Power source | Payload | Notes |
|---|---|---|
| Built-in AI | `brain_type: "built_in"`, `metadata.source_type: "built_in"` | Most AI tools. Set `model_config` (load `ai-models.md`) |
| Static / No AI | `brain_type: "none"`, `metadata.source_type: "static"` | Calculators, converters, timers. User-run in its panel: never an agent tool (its `agentUseEnabled` only lets agents read its settings) |
| n8n Workflow | `brain_type: "n8n_workflow"`, `metadata.source_type: "n8n"`, webhook URL | Load `brain-n8n.md` |
| Custom Webhook | `brain_type: "custom_webhook"`, `metadata.source_type: "custom"`, webhook URL | Non-n8n endpoint |
| ComfyUI | `brain_type: "none"`, `metadata.source_type: "comfyui"`, `agent_use_enabled: false` | User-run panel artifact; load `brain-comfyui.md`. Installed in Pinokio? Use Pinokio App |
| HuggingFace / Gradio embed | `brain_type: "none"`, `metadata.source_type: "huggingface"` or `"gradio"`, `agent_use_enabled: false` | User-only; needs enforcement off |
| Pinokio App | `brain_type: "pinokio_app"`, `metadata.runtime_manager: "pinokio"`, `pinokio_app_id`, `source_type` = the app's kind | ANY app installed in Pinokio (ComfyUI and Gradio too); agents can run it. Load `runtime-pinokio.md` first |

Only artifacts that `native_batshit_tool_search` (`family: "artifact"`) returns as `artifact:use.artifact.{slug}` refs are agent-runnable. If asked to run a user-only artifact as an agent, say you cannot; never change its power source to force it.

**Model choice (built-in AI):** the artifact owns its model. Find the exact model with `sys.model_catalog.search` and store it in `model_config` on create. Never silently choose a fallback or substitute model: ask the user when the intended model is unavailable or the choice is genuinely ambiguous (a generic "image generator" with no provider named).

## Zones

| Zone | For | Layout |
|---|---|---|
| panel | Rich tools, generators, dashboards | Full width, generous spacing |
| header | Focused overlay tools | Card-based, self-contained |
| trigger | One-click actions | Compact: fields, button, small result |

## Icon

Set `icon_ref` on create (never emoji, never the legacy `icon` field, never invented IDs): image tools `{ kind: "lucide", id: "image" }`; creative or static utilities `{ kind: "lucide", id: "palette" }`; AI helpers `{ kind: "lucide", id: "sparkles" }`; prompt or magic-edit tools `{ kind: "lucide", id: "wand-sparkles" }`; search `{ kind: "lucide", id: "search" }`; documents `{ kind: "lucide", id: "book-open" }`; audio `{ kind: "lucide", id: "audio-lines" }`; dashboards `{ kind: "lucide", id: "chart-bar" }`; n8n `{ kind: "brand", slug: "n8n-color" }`; ComfyUI `{ kind: "brand", slug: "comfyui-color" }`; Hugging Face `{ kind: "brand", slug: "huggingface-color" }`; Gradio `{ kind: "brand", slug: "gradio-color" }`; anything else `{ kind: "batshit", id: "artifacts" }`.

## Controls: exact refs and inputs

Call these directly; no search needed: `native_batshit_tool_use({ ref: "fabric:sys.artifact.create", input: { ... } })`.

| Ref | Input |
|---|---|
| `fabric:sys.artifact.create` | `name`, `content` (full HTML), `metadata` (`source_type`, `fabric_fields` or `run_only`), `brain_type`, `zone`, `icon_ref`, `mode` (`"published"` publishes in the same call; `"edit"` keeps a draft), `model_config` and `system_prompt` (Built-in AI: the model, and the standing instructions every run uses), `webhook_url` (n8n or custom webhook), `agent_use_enabled` |
| `fabric:sys.artifact.update` | `artifactId` plus the fields to change (`content`, `metadata`, `mode`, `zone`, `model_config`, `system_prompt`, `versionDescription`); `content` needs `expectedVersion`: the `version` your last `get` (with content), `create`, `content` update, or `add_version` showed, never apply_patch, publish, zone, webhook, metadata, field, or rollback result; existing access settings are user-owned |
| `fabric:sys.artifact.publish` | `artifactId`, `publish: true`, `zone` |
| `fabric:sys.artifact.get` | `artifactId`; `includeContent` / `includeVersions` default on, `includeVersionContents` off |
| `fabric:sys.artifact.apply_patch` | `artifactId`, `patch` (one string; format in `editing.md`), `versionDescription` |
| `fabric:sys.artifact.validate_structure` | `content` plus `metadata`, or `artifactId`: the save checks without saving |
| `fabric:sys.model_catalog.search` | `query`, optional `provider`, `purpose` (`chat`, `visual`, `audio`, or `utility`), `limit` |
| `fabric:sys.artifact.list` | none; compact summaries |
| `fabric:sys.artifact.run_logs.list` / `.get` | `artifactId` / `artifactId`, `runId` |

Writes answer with a compact summary; an update also lists `updatedFields` and `contentChanged`. Trust it: call `sys.artifact.get` only when you need the current HTML to edit, or after an update whose summary does not show the change you made. For anything else (`set_zone`, `set_webhook`, versions), search `family: "fabric"`.

## Which reference to load

| Reference | Load when |
|---|---|
| `brain-general.md` | Building any native artifact (static, built-in AI, webhook): the build steps, Builder Kit use, action bar, theme |
| `builder-kit-api.md` | Writing the UI: every form, output, and action component and its options |
| `ai-capabilities.md` | The artifact calls AI: `complete()`, `generateImage()`, `editImage()`, `speak()`, `streamObject()` |
| `ai-models.md` | Choosing or repairing a built-in AI model: catalog search, `model_config`, model troubleshooting |
| `runtime-api.md` | The artifact needs storage, events, metadata, saved API keys, Clip Vault images, or the low-level share API |
| `fabric-and-agent-use.md` | The user wants agents to use the artifact, or an agent run fails |
| `editing.md` | Changing an existing artifact: patches, versions, rollback, multi-session builds |
| `zone-patterns.md` | A custom visual layout (dashboard grid, split view) needs a zone-sized scaffold; not for Builder Kit forms |
| `templates-gallery.md` | You want a proven code pattern: streaming output, context passing, file preview, persistent state |
| `runtime-location.md` | The artifact depends on a local runtime, sidecar, webhook host, or Docker |
| `brain-comfyui.md` | Turning a ComfyUI workflow into an artifact: readiness, the workflow, the fields |
| `comfyui-build.md` | Writing the ComfyUI artifact once its fields are agreed |
| `comfyui-reference.md` | ComfyUI uploads, model lists, cancel, errors, family defaults, endpoints |
| `brain-n8n.md` | Turning an n8n workflow into an artifact |
| `n8n-troubleshooting.md` | An n8n artifact misbehaves, or you need the Instance MCP's limits |
| `brain-huggingface.md` | A HuggingFace Space (embed) or the HF Inference API |
| `embed-gradio.md` | Embedding a standalone Gradio app |
| `runtime-pinokio.md` | The app is installed in Pinokio (ComfyUI, Gradio, or its own API) |

A static tool such as a calculator needs only `brain-general.md` and `builder-kit-api.md`.

## Working style

- `/artifact-creator` alone loads the toolkit; ask what to build. Once you have a request, build it with smart defaults instead of a list of questions.
- Keep the user's words plain. Confirm before destructive changes (deleting a version, moving a published artifact).
- When it works, publish it yourself and say where it landed. Never end on tool cards alone: say what was built and where to find it.
- A failing run: read `sys.artifact.run_logs.list` / `.get` before guessing.
- Keep this skill and the active reference unzipped until the artifact is saved, published, and has run once; then zip older reference text.
- Integrations come through Dynamic Tool Search `family: "mcp"`; if n8n or HuggingFace tools are missing, say so plainly and build the best available path.
- Docker Batshit: `localhost` differs between the browser, the app container, and sidecars. Load `runtime-location.md` before depending on any local runtime.
