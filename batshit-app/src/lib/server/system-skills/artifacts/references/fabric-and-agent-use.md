# Agent Use and Fabric

**Load when:** the user wants agents to use (or stop using) an artifact, you need to limit which agents can, or an agent run of an artifact fails. The field contract itself (`fabricId` plus `metadata.fabric_fields`) is already in SKILL.md and `builder-kit-api.md`.

## Which artifacts agents can run

Agents run an artifact through its `artifact:use.artifact.{slug}` ref. Batshit offers that ref only when all of these hold:

1. It has a Batshit runtime: **Built-in AI**, **n8n Workflow**, **Custom Webhook**, or **Pinokio App** (`runtime-pinokio.md`). Static / No AI tools, ComfyUI panel artifacts, and Gradio / HuggingFace embeds are user-only: they work in their panel, and no ref is offered.
2. It is **published**.
3. It declares its fields (`metadata.fabric_fields`, matched by `fabricId`s in the page) or `metadata.run_only: true`.
4. Agent use is on for that agent (below).

If the user asks you to run a user-only artifact, say you cannot run it as an agent and why. Never change its power source or `brain_type` to force it. If they need an agent-runnable version, build a Built-in AI or webhook artifact, or a Pinokio App artifact when the app is installed in Pinokio.

## Who can use it

A new artifact is **on for all agents** by default (`agent_use_enabled` true, `agent_access_scope: "all"`), so there is nothing to set. State the initial access in your build summary. Creation settings do not give you authority to change access on an existing artifact.

Only the user changes existing access. Direct them to Settings → Artifacts for **Agent Use** and **Enable For All Agents**, or Settings → Agents → Access for the per-agent checklist. A `"selected"` scope with an empty allowlist means no agent can use it.

Never send `agent_use_enabled`, `agent_access_scope`, or `agent_allowlist` to `sys.artifact.update`, even when the user asks in chat. Batshit refuses the whole update with `ARTIFACT_ACCESS_USER_ONLY`; no accompanying content edit is saved. Explain the setting the user needs to change and continue any independent content work without those fields.

Build every runnable artifact with its fields declared even when agent use is off, so switching it on later needs no rebuild.

## The field contract

`metadata.fabric_fields` lists what the artifact accepts: `{ fabricId, type, label }`, plus `required`, `options` (select, radio, multiselect), and `min` / `max` (number, slider) when they apply.

```json
{ "metadata": { "source_type": "built_in", "fabric_fields": [
  { "fabricId": "search-query", "type": "text", "label": "Search query", "required": true },
  { "fabricId": "output-format", "type": "select", "label": "Output format", "options": ["Summary", "Table"] }
] } }
```

- A trigger with no inputs sets `metadata.run_only: true` instead.
- Keep `required` for what an agent must send (often just the main text or prompt); everything else should have a sensible default.
- Image generators use the semantic IDs from `ai-capabilities.md` (`source-image-1-url`, `image-count`, `aspect-ratio`, `resolution`).
- An agent run sends the field values and an optional `prompt`; the artifact's `system_prompt` supplies the standing instructions.

## The three kinds of refs

- **`sys.artifact.*`**: the building controls (create, update, publish, get, ...).
- **`use.artifact.{slug}`**: the runtime tool for one published, agent-usable artifact. Search `native_batshit_tool_search` with `family: "artifact"`; use the exact `artifact:` ref it returns.
- **`artifact.<id>.field.*` / `artifact.<id>.action.*`**: per-artifact settings controls (model, system prompt, zone, details, publish). They change settings, never the HTML.

## Test run

1. Publish it (`mode: "published"` on create, or `sys.artifact.publish`).
2. Search `family: "artifact"` for its name and copy the exact ref.
3. Call it with realistic values.
4. Image generators: read `sys.artifact.run_logs.get` even on success; `result.fileCount` (or `generatedFileCount`) must be above 0.

A portable agent whose token cannot run artifact tools asks the user to run it once in Batshit instead.

If no ref appears, check: is it a runtime power source, published, declaring fields or `run_only`, with agent use on for you? A user-only artifact is expected not to appear.

If you published only to test and the user wants it kept as a draft, set `publish: false` afterwards.

## When something goes wrong

- **`CONTROL_NOT_FOUND`:** search `family: "artifact"` again without filters, copy the exact ref, retry once.
- **`CONTROL_RISK_REQUIRES_APPROVAL`:** Batshit **paused** the call and put an **Approve** / **Deny** card on your message. It is not a refusal, and you cannot unlock it yourself. Tell the user what the control does and why, then stop. Never pass `allowRisky`: it is ignored on every chat lane. An API agent does not retry: the user's click re-runs that same call. A Codex or Claude agent is resumed with an `[Approval — from the user, not from the agent]` message and then retries the same ref with the **same input** (a different input is a different call, and earns a new card). **Deny** starts no turn; you hear about it on the user's next message, and you must not retry.
- **`prompt is required`:** retry with a non-empty `input.prompt`.
- **Wrong or empty output:** `sys.artifact.run_logs.list`, then `sys.artifact.run_logs.get` for the latest run: the chat link, a scrubbed prompt preview, the resolved model, the route, output counts, usage, and sanitized errors. For a model problem, load `ai-models.md`.
- **Two failures in a row on the same step:** stop. Tell the user the blocker, the exact IDs you tried, and the next best action.
