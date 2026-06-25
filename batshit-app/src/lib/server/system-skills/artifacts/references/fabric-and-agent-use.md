# Making Your Artifact Agent-Friendly

Your artifact is built — nice work! Now let's set it up so your AI agents can discover and use it as a tool. This is the step that makes Batshit artifacts genuinely special: they're not just widgets you click, they're tools your agents can find and operate on their own.

**If you're building a Gradio or HuggingFace Space embed**, skip this doc entirely. These embeds are user-only, must save with `agent_use_enabled: false`, and do not appear in Agent settings. The embed reference doc explains this.

**Important:** for all normal Batshit artifacts, this Fabric setup is not optional anymore when structure enforcement is on. Saves are blocked unless the artifact declares `metadata.fabric_fields` or `metadata.run_only=true`.

Run `sys.artifact.validate_structure` before every save while you are doing this work. It gives you the same Builder Kit + Fabric verdict Batshit will enforce later, but earlier in the loop.

---

## Step 1: Ask the User About Agent Access

Before configuring anything, ask the user:

> "Should your AI agents be able to use this artifact as a tool? That means your agents could discover it and use it on their own — for example, if you asked an agent to generate an image, it could find this artifact and run it automatically without you having to open it yourself. You can always change this later, so there's no pressure either way."

If the user doesn't understand, explain it more simply: "Right now only you can use this artifact by clicking on it. If we turn on agent access, your AI assistants can also use it when they need to — like having a tool in their toolbox."

**Whether the user says yes or no**, you'll still set up the technical pieces (fabricId on form fields, fabric_fields in metadata). This way the artifact is ready for agent access the moment they decide to turn it on — no rebuild needed.

---

## Step 2: Add fabricId to Your Form Fields

Every form field that an agent should be able to fill in needs a `fabricId`. This is the name agents use to set that field's value when they call the artifact programmatically.

```javascript
window.batshit.builder.form.text({
  label: 'Search Query',           // What the user sees
  placeholder: 'What to search...',
  fabricId: 'search-query',        // What agents use to fill this field
  onChange: (val) => { query = val; }
})

window.batshit.builder.form.select({
  label: 'Output Format',
  options: ['Summary', 'Table', 'Raw JSON'],
  value: 'Summary',
  fabricId: 'output-format',
  onChange: (val) => { format = val; }
})
```

After creating a Builder Kit field, mount it with `window.batshit.builder.mount(container, field)`. When you need the underlying DOM control, use `field.input`.

**Naming rules:**
- Use clear, descriptive names: `positive-prompt`, `output-format`, `temperature` — not `field1`, `input2`
- Each fabricId must be unique within the artifact
- File inputs (`uploadButton`, `dropFile`) do not support fabricId (browser security limitation)
- For image-generation artifacts, use semantic text fields for agent-provided source/reference images. Supported naming patterns include `source-image-1-url`, `source-image-2-url`, `source-image-3-url`, `reference-image-url`, and `input-image-url`. When the artifact's configured model is image-capable, Batshit sends those values as structured image inputs instead of prompt text. Common controls such as `image-count`, `aspect-ratio`, and xAI `resolution` are also mapped to runtime options.

### Which Field Types Map to What

| Builder Kit Primitive | fabricId Type | What Agents Send |
|---|---|---|
| `text`, `textarea` | `string` | `{ type: "string" }` |
| `number` | `number` | `{ type: "number", minimum?, maximum? }` |
| `slider` | `number` | `{ type: "number", minimum?, maximum? }` |
| `select`, `radio` | `string` with enum | `{ type: "string", enum: [...] }` |
| `multiselect` | `array` | `{ type: "array", items: { type: "string", enum: [...] } }` |
| `checkbox`, `toggle` | `boolean` | `{ type: "boolean" }` |
| `promptPair` | `object` | `{ type: "object", properties: { prompt, negativePrompt } }` |

---

## Step 3: Declare fabric_fields in Metadata

After building the artifact code with fabricId on form fields, update the artifact's metadata so Batshit knows what fields exist:

```json
{
  "controlId": "sys.artifact.update",
  "input": {
    "artifactId": "...",
    "metadata": {
      "fabric_fields": [
        { "fabricId": "search-query", "type": "text", "label": "Search Query" },
        { "fabricId": "output-format", "type": "select", "label": "Output Format", "options": ["Summary", "Table", "Raw JSON"] }
      ]
    }
  }
}
```

The `fabric_fields` array tells Batshit (and agents) exactly what parameters this artifact accepts. Each entry needs at minimum: `fabricId`, `type`, and `label`.

**For trigger-only artifacts** (no input fields — just a button that runs something), set `metadata.run_only: true` instead of `fabric_fields`.

---

## Step 4: Configure Agent Access

Now set whether agents can actually discover and use this artifact:

**If the user said yes to agent access:**
```json
{
  "controlId": "sys.artifact.update",
  "input": {
    "artifactId": "...",
    "agent_use_enabled": true,
    "agent_allowlist": ["agent_id_1", "agent_id_2"]
  }
}
```

Ask which agents should have access. The user needs to select at least one agent — if the allowlist is empty, no agents can use it even with agent_use_enabled on.

If the user says "all agents," translate that into an explicit `agent_allowlist` containing all currently available agent IDs. Do not leave the allowlist empty.
If the user just says "yes, agents should use it" and does not name specific agents, default to **all current agents**.
If an allowlist ever becomes empty again, treat that as disabled agent use rather than saving an empty enabled state.

**If the user said no to agent access:**
```json
{
  "controlId": "sys.artifact.update",
  "input": {
    "artifactId": "...",
    "agent_use_enabled": false
  }
}
```

The Fabric infrastructure is still in place (fabricId, fabric_fields) — it just won't be discoverable by agents until they toggle it on.

**Important nuance**: `agent_use_enabled: true` with an empty allowlist = invisible to all agents (same as disabled). Only `agent_use_enabled: undefined` (legacy artifacts created before this system) = visible to all agents. This is a subtle but important distinction.

---

## Step 5: Understand the Three Prefixes

You'll see three kinds of control IDs. Here's what each one is for:

- **`sys.artifact.*`** — Fabric control-plane building tools. These are what you've been using to create, update, configure, and publish artifacts. Call them through the Fabric control transport available in your current lane.

- **`use.artifact.{slug}`** — Runtime capability. This only appears after an artifact is published with agent use enabled, a non-empty allowlist, and a valid backend Batshit runtime contract (fabric_fields or run_only). Agents call it through the Artifact runtime tool lane, not through the general artifact-management controls. Portable Artifact Tokens do not automatically grant this runtime lane.

User-only panel artifacts do not get a `use.artifact.{slug}` runtime tool. That includes raw Gradio/HuggingFace embeds and current ComfyUI panel artifacts, even when they have Builder Kit controls. If the user asks you to use one, tell them it is user-only for now. Do not change its `brain_type`, Artifact Power Source, or runtime settings to force agent use.

- **`artifact.<id>.field.*` / `artifact.<id>.action.*`** — Per-instance controls for a specific artifact's metadata fields. These may appear in current-message agent context for existing artifacts. They can only set metadata — not create artifacts or set HTML content.

---

## Step 6: Publish and Test (Required Order)

`use.artifact.{slug}` only appears after publish + runtime contract checks. So the safe order is:

1. Publish the artifact first
2. If your current lane can search the Artifact runtime tool family, search for `use.artifact.{slug}` and make sure it appears
3. If your current lane can invoke that runtime tool, call it with test values
4. If your lane cannot invoke published artifact runtime tools, ask the user to run the published artifact in Batshit or test it from a normal Batshit agent with access
5. If it is a generated-image artifact, inspect the scrubbed run log even when the tool reports success. `result.fileCount` or runtime `generatedFileCount` must be greater than 0.
6. If the run fails or returns the wrong kind of output, inspect the scrubbed run log with `sys.artifact.run_logs.list` and `sys.artifact.run_logs.get` before guessing

If `use.artifact.{slug}` doesn't appear, check: is the artifact published? Is agent_use_enabled true? Is the allowlist non-empty? Does it have fabric_fields or run_only?

If the artifact is a user-only Gradio/HuggingFace embed or a ComfyUI panel artifact, stop here. It is expected not to appear as an agent tool.

---

## Step 7: Confirm Final Publish State

If it isn't published yet, publish it:

```json
{
  "controlId": "sys.artifact.publish",
  "input": { "artifactId": "...", "publish": true, "zone": "panel" }
}
```

Confirm the zone is what the user wants. Then tell them where to find their artifact — "Your artifact is now live in the panel zone. You'll see it in your workspace panel."

If you published only for runtime testing and the user wants to keep it private/draft for now, explicitly set publish back to `false` after testing.

---

## If Something Goes Wrong

### Control not found

If an artifact runtime call returns `CONTROL_NOT_FOUND`: rerun the current lane's Artifact runtime search without filters, copy the exact `artifact:` ref from the results, and retry once. If the lane cannot search Artifact runtime tools, verify in the app that the artifact is published and agent-usable.

### Risk approval needed

If a control returns `CONTROL_RISK_REQUIRES_APPROVAL` and the user approved: retry immediately with `allowRisky: true` using the exact same payload.

### Prompt is required

If an artifact runtime call fails with `prompt is required`: retry with a non-empty `input.prompt` field.

### Runtime completed but output is wrong

Use `sys.artifact.run_logs.list` for the artifact, then `sys.artifact.run_logs.get` for the latest run. Check the session/message linkage, scrubbed prompt preview, resolved model, chosen transport, output counts, usage, and sanitized error list. These logs are scrubbed: they do not include API keys, auth tokens, cookies, or raw image/audio/base64 payloads. They are retained for about two weeks, deleted when the Artifact is deleted, and kept across Artifact version edits, rollbacks, or version deletion.

For image generators, a runtime success with `result.fileCount: 0` or `generatedFileCount: 0` is not complete. Fix the selected image model, saved provider key, or runtime helper call and test again before handoff.

### Stuck in a loop

After 2 consecutive failures on the same operation: **stop looping.** Provide a clear summary of the blocker, the exact IDs you attempted, and the next best action. Don't keep retrying the same thing.

---

## Why This Matters

Making artifacts agent-friendly is what sets Batshit apart from every other AI platform. Here are just a few examples of what becomes possible:

- An agent researches a topic and drops the findings into a RAG artifact, which triggers an n8n workflow to upload to a vector store
- An AI persona uses a character-consistent image generation artifact and shares the result through the standard action controls
- A monitoring agent periodically reads a dashboard artifact's state and alerts the user when something needs attention

The artifact becomes a permanent tool in the agent's toolbox — discoverable by name, callable with typed parameters, results flowing back into the conversation. No other platform does this.
