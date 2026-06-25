# n8n Workflow Artifact Builder Guide

You are helping a user turn their **existing, working n8n workflow** into a polished Batshit artifact — a persistent mini-app with a clean UI that lives in their workspace. This guide walks you through the entire process step by step.

n8n is the workflow builder — it's already great at that, with a visual editor, 400+ nodes, and a massive community. Batshit's job is to give those workflows a beautiful, one-click frontend that lives in your workspace.

## Step 0: Builder Kit + Workflow-Key Contract (Mandatory)

Batshit now enforces artifact structure at save time unless the user manually turned that toggle off for this artifact in Settings -> Artifacts.

- Use **Builder Kit** for the UI
- Declare the **Fabric runtime contract** (`metadata.fabric_fields` or `metadata.run_only=true`)
- Keep every `fabricId` exactly aligned with the workflow's `$json.body.*` keys

If you skip those pieces, the artifact will not save.

Also: run `sys.artifact.validate_structure` before every save or publish pass so you catch mismatched `fabricId` drift before the real save call.

Before you inspect the workflow deeply or write UI code, lock this mini-plan:

1. Identify the exact workflow keys (`action`, `query`, `source`, etc.)
2. Map each key to a Builder Kit primitive
3. Reuse that same key as the `fabricId`
4. Declare the same key in `metadata.fabric_fields`
5. Start the artifact body with the workflow controls/status, not a repeated title or generic description
6. Validate structure before the first save

### Fast Mental Checklist

- [ ] I will use `window.batshit.builder.form.*` for the main controls
- [ ] I will not invent prettier `fabricId` names if the workflow expects a different key
- [ ] Every `fabricId` matches the workflow's `$json.body.*` key exactly
- [ ] I will include `standardControls()` for result-style artifacts
- [ ] I will not render the artifact title or a generic description at the top of the artifact body
- [ ] I will run `sys.artifact.validate_structure` before saving

If you are about to build the UI first and "translate keys later," stop. For n8n artifacts, the key names are the contract.

---

## Prerequisites — Is the User Ready?

Before you start the artifact building process, the user MUST have:

1. **An n8n workflow that already works** — built, tested, and doing what they want
2. **A webhook trigger on the workflow** — this is how the artifact will call it (if the workflow doesn't have one yet, they need to add one in n8n first)

**If either prerequisite is missing, STOP.** The artifact building process is not the right next step yet. Instead:
- Help the user understand what they need: "Once you have a working workflow in n8n with a webhook trigger, we can give it a beautiful UI in Batshit. Come back when you're ready!"
- You can help them think through what their workflow should do, but the actual building happens in n8n's visual editor — not here
- Do NOT try to create n8n workflows from chat — n8n's editor is purpose-built for that

---

## Step 1: Understand What Kind of n8n Artifact

There are four main patterns. Ask the user which one best fits what they want:

### Type 1: One-Button Trigger
"Press a button, something happens." Backup my database, deploy the latest build, sync contacts to CRM, send my daily report.
- **UI**: Button + status indicator + optional result card
- **Best zone**: `trigger` or `header`

### Type 2: Form → Result
"Fill in some fields, submit, get a response." Invoice generator, notification sender, lead qualifier, calendar event creator.
- **UI**: Input fields + submit button + result display
- **Best zone**: `panel`

### Type 3: Upload → Process
"Give it some content, it processes it." RAG document uploader, CSV processor, receipt scanner, contract analyzer.
- **UI**: Textarea or drag-and-drop + upload progress + result card
- **Best zone**: `panel`

### Type 4: AI Chat via n8n
"Enter a prompt, get an AI response through n8n." Knowledge base Q&A, email draft assistant, content generator.
- **UI**: Prompt input + context controls + streaming output
- **Best zone**: `panel`

If the user isn't sure, ask them to describe what happens when they manually trigger the workflow in n8n — the answer usually maps clearly to one of these four.

---

## Step 2: Find and Inspect the Workflow

### If n8n inspection tools are available

Use the n8n inspection method available in your current lane. In-app agents may have n8n Instance MCP tools. Portable agents may have their own outside-agent tools, shell access, or only the user's description.

If inspection is available, search for the user's workflow and inspect its details before building. Do not assume the portable Batshit token grants n8n inspection access; it only grants Batshit artifact controls.

**What to look for when inspecting:**
- What inputs does the workflow expect? (Look at `$json.body.*` expressions)
- What does it return? (Look at the Respond to Webhook node)
- Does it process binary data? (Important — see limitations below)
- How long does it typically take to run?

### If Instance MCP Is NOT Available

That's fine — just ask the user directly:
- "Which workflow do you want to turn into an artifact?"
- "Can you share the webhook URL for it?"
- "What information does the workflow need as input? Like, what fields would someone fill out?"
- "What does it send back when it's done?"

If the user isn't sure about the input shape, ask them to trigger the workflow manually in n8n and share what the Respond to Webhook node returns.

---

## Step 3: The fabricId Golden Rule

This is the **most important thing** in this entire guide. Getting this wrong is the #1 cause of broken n8n artifacts.

### What's a fabricId?

Every form field in your artifact can have a `fabricId` — this is the name that gets sent as a key in the webhook body when the artifact calls the workflow. It's also the name agents use when they call the published artifact through the artifact runtime tool lane.

### The Rule: fabricId MUST Match the Workflow's Expected Keys

When you inspected the workflow (or asked the user), you learned what keys the workflow reads from the incoming webhook body. Those keys are found in `$json.body.*` expressions throughout the workflow nodes.

**Your fabricId values must be the EXACT same strings.**

If the workflow reads `$json.body.query`, your fabricId must be `query` — not `search-query`, not `user-query`, not `queryText`.

If the workflow reads `$json.body.action`, your fabricId must be `action` — not `select-action`, not `action-type`.

**The `label` can be anything human-readable.** It's what the user sees. The `fabricId` is the machine key — it must match exactly.

```javascript
// Workflow reads: $json.body.action, $json.body.query, $json.body.source

const action = window.batshit.builder.form.select({
  label: 'What to do',         // Human-readable — can be anything
  fabricId: 'action',          // MUST match: $json.body.action
  options: ['add', 'query', 'list', 'delete']
})

const query = window.batshit.builder.form.text({
  label: 'Search Query',      // Human-readable
  fabricId: 'query'            // MUST match: $json.body.query
})

const source = window.batshit.builder.form.text({
  label: 'Source Name',        // Human-readable
  fabricId: 'source'           // MUST match: $json.body.source
})

const controls = document.getElementById('controls')
window.batshit.builder.mount(controls, action)
window.batshit.builder.mount(controls, query)
window.batshit.builder.mount(controls, source)
```

### How to Find the Keys

If you have Instance MCP access, inspect the workflow and scan for every `$json.body.*` expression:
- **Switch/Router nodes** — what field do they branch on? (e.g., `$json.body.action`)
- **AI/Agent nodes** — what text input do they read? (e.g., `{{ $json.body.query }}`)
- **Set nodes** — what fields do they extract? (e.g., `$json.body.source`, `$json.body.content`)
- **The Webhook node itself** — some workflows declare expected body fields there

Write down every key: e.g., `{ action, query, source, content }`. These become your fabricId values.

**Golden rule: adapt the artifact to the workflow — NEVER ask the user to change their n8n expressions.** The workflow is already live and possibly used by other systems. Fix mismatches in the artifact, not in n8n.

---

## Step 4: Walk the User Through the Settings

Based on what you learned about the workflow, explain what you found in plain language:

- "I can see your workflow expects three inputs: an action (add, query, list, or delete), a query text, and a source name. I'll create a form with a dropdown for the action and text fields for the other two."
- "The workflow returns a text confirmation. I'll display that in a result card with Share/Save/Download buttons."
- "This looks like a Form → Result artifact. I'd suggest putting it in the panel zone since the results might be long. Sound good?"

Let the user confirm or adjust before building.

---

## Step 5: Build the Artifact

Now you're ready to write code. Load `references/builder-kit-api.md` if you haven't already.

### Create the Artifact

```json
{
  "controlId": "sys.artifact.create",
  "input": {
    "name": "Knowledge Base Manager",
    "content": "<!DOCTYPE html>...",
    "icon_ref": { "kind": "brand", "slug": "n8n-color" },
    "metadata": { "source_type": "n8n" },
    "mode": "edit"
  }
}
```

### Wire Up the Webhook Call

The core pattern — your artifact calls the saved n8n workflow through `window.batshit.complete()`:

```javascript
async function triggerWorkflow(formData) {
  const response = await window.batshit.complete(
    'Execute workflow',
    {
      context: formData,
      mode: 'complete'
    }
  );

  const result = response?.text ?? response;
  document.getElementById('output').textContent = result;
  window.batshit.storage.set('lastResult', result);
}
```

### Set the Webhook URL

```json
{
  "controlId": "sys.artifact.set_webhook",
  "input": {
    "artifactId": "...",
    "webhook_url": "https://your-n8n-instance/webhook/...",
    "brain_type": "n8n_workflow"
  }
}
```

### Add Standard Action Controls

Every artifact needs the Share/Save/Download bar:

```javascript
const actions = window.batshit.builder.action.standardControls({
  storageKey: 'lastResult',
  title: 'Workflow Result',
  shareOptions: { type: 'data', format: 'markdown', initiator: 'user' }
});
window.batshit.builder.mount(document.getElementById('actions'), actions);
```

---

## Step 6: Configure Webhook Passthrough (Recommended for Fabric)

By default, when an agent calls an n8n artifact through the artifact runtime wrappers, Batshit wraps the payload in an envelope (`{ artifactId, prompt, context, ... }`). Most n8n workflows don't expect this wrapper — they read flat keys like `$json.body.query`.

**Webhook passthrough** fixes this: Fabric field values are sent directly as the webhook body, exactly matching what the workflow expects.

### Enable Passthrough

```json
{
  "controlId": "sys.artifact.update",
  "input": {
    "artifactId": "...",
    "metadata": { "source_type": "n8n", "webhook_passthrough": true }
  }
}
```

### What Passthrough Does

Both user clicks and agent calls produce the same payload:

- **User clicks submit** → webhook receives `{ action: "query", query: "how does X work?" }`
- **Agent calls via the artifact runtime tool lane** → webhook receives `{ action: "query", query: "how does X work?" }`

The n8n workflow always sees the same flat payload, no matter who triggered it.

### When NOT to Use Passthrough

- If the workflow was specifically designed for the Batshit envelope format (`{ artifactId, prompt, context, ... }`)
- For artifacts using built-in AI (not webhook)

---

## Step 7: Finish Up — Agent Access and Publishing

Your artifact is built! Now load the `fabric-and-agent-use` reference to set up agent access and publish it yourself.

Load `references/fabric-and-agent-use.md`. It walks you through asking the user about agent access, configuring Fabric fields, testing, and publishing.

Do not stop at “ready to publish.” Finish the job by publishing it yourself once it is working.

---

## Instance MCP Limitations

Know these before relying on Instance MCP:

1. **Binary data flooding**: If a workflow processes images or files internally, Instance MCP returns ALL internal execution data — not just the final output. A 600-character text response can balloon to 200,000+ tokens. This doesn't affect artifacts (they call via webhook, not MCP), but matters if you use MCP's execute tool directly.

2. **5-minute timeout**: Workflows that don't complete within 5 minutes are killed. Hard limit.

3. **Text-only input**: Instance MCP can only send text to workflows. No binary uploads. (Artifact webhooks can send anything.)

4. **Read-only**: Instance MCP cannot create, edit, or activate workflows. Discovery and execution only.

5. **Two-level opt-in**: MCP must be enabled at the n8n instance level AND each workflow must individually opt-in. Not all workflows are automatically visible.

**Bottom line**: Use Instance MCP for **discovering and inspecting** workflows. Use **webhook URLs** for artifact **execution**.

---

## Debugging n8n Artifacts

### fabricId Mismatches — The #1 Problem

If your n8n artifact returns **"Unexpected end of JSON input"** or any JSON parse error from n8n, the almost-certain cause is a fabricId mismatch:

1. The artifact sent a body key the workflow doesn't recognize (e.g., `body.search-query` when it reads `body.query`)
2. The workflow received `undefined` for that key
3. An AI node got an empty string as input → called the model with no prompt → model returned empty body → `JSON.parse("")` throws

**How to fix:**
1. Inspect the workflow (Instance MCP or ask the user)
2. List every `$json.body.*` key that appears in the workflow
3. Compare each key against your artifact's fabricId values
4. Fix mismatches in **THREE places**: `data-fabric-id` HTML attribute, `fabric_fields` metadata array, AND `initFabricHandoff` JS handler
5. Save via `sys.artifact.update`, publish, and re-test

**"The list action works but query fails"** — Classic sign of a per-branch mismatch. The `list` branch doesn't read the mismatched field, so it succeeds. The `query` branch reads the missing key → undefined → empty AI prompt → parse error. Inspect the `query` branch nodes specifically.

**Remember: fix the fabricId in the artifact — NOT the `$json.body.*` expression in n8n.**

### Webhook Response Format

n8n should return:
- **Plain text** (Content-Type: text/plain) — displayed directly
- **JSON** with a `text` or `response` field — extracted and displayed
- **Streaming is NOT supported** from webhooks — responses are buffered

**Best practice for Respond to Webhook**: Return a clear, readable confirmation string.

Good: `{ "text": "Added 12 chunks from 'Q4 Report' to your knowledge base." }`
Bad: `{ "success": true }` or `{ "status": "ok" }`

---

## Scenario Inspiration

Here are common n8n artifact patterns to spark ideas:

**RAG / Knowledge Base Upload** — User pastes content or a URL → n8n chunks it, generates embeddings, uploads to vector store → confirms "Added 12 chunks." Agent can also call it through the artifact runtime tool lane to drop research findings into the knowledge base automatically.

**Multi-Channel Notifications** — Dropdown for channel (Email, Slack, Discord, SMS) + recipient + message fields → n8n routes to the right integration → confirms delivery. Agent uses it to send alerts without loading notification MCPs.

**Database Query Interface** — Natural language query → n8n converts to SQL, runs it, formats the result → shares clean answer back to chat. Keeps raw database results out of the agent's context window.

**Document Generator** — Template type (Invoice, Contract, Report) + client name + details → n8n merges into template, generates PDF, optionally emails → shares download link. Agent closes a deal, invoice generated automatically.

**Data Processing Pipeline** — Paste messy CSV/JSON/text → n8n normalizes, dedupes, categorizes → shares clean output. Agent fetches data from a source, runs it through the pipeline, shares the processed summary.
