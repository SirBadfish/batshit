# n8n Workflow Artifact Guide

**Load when:** the user wants one of their existing, working n8n workflows (with a webhook trigger) given an artifact front end. It covers readiness, the four artifact shapes, finding the workflow's keys, the `fabricId` golden rule, the build, and webhook passthrough. Load `n8n-troubleshooting.md` when a workflow artifact misbehaves or you need Instance MCP's limits.

n8n is the workflow builder; Batshit gives those workflows a one-click front end in the workspace.

## The contract

- The UI is **Builder Kit** (`window.batshit.builder.form.*`), with a `label` on every field and results in `standardControls()`.
- `metadata.fabric_fields` declares the fields (or `metadata.run_only: true` for a one-button trigger).
- **Every `fabricId` is exactly a `$json.body.*` key the workflow reads.** For n8n the key names are the contract: never build the UI first and "translate keys later".
- No title or generic description at the top of the body.

## Is the user ready?

They need an n8n workflow that already works, with a **webhook trigger** (the artifact calls that). If either is missing, stop the artifact build: the workflow is built and tested in n8n's editor, not from chat. Help them think it through, and say "once the workflow works in n8n with a webhook trigger, we can give it a front end here."

## Step 1: Which shape?

| Shape | Example | UI | Zone |
|---|---|---|---|
| One-button trigger | Back up the database, send the daily report | Button, status, optional result card | trigger or header |
| Form -> result | Invoice generator, lead qualifier | Fields, submit, result | panel |
| Upload -> process | RAG uploader, CSV cleaner | Text box or drop zone, progress, result | panel |
| AI chat via n8n | Knowledge-base Q&A, email drafts | Prompt, context controls, output | panel |

If the user is unsure, ask what happens when they trigger the workflow by hand in n8n; the answer usually maps to one of these.

## Step 2: Find the workflow and its keys

With n8n inspection tools in your lane (in-app: search `family: "mcp"` for the n8n Instance MCP), find the workflow and inspect it:

- The inputs it expects: every `$json.body.*` expression.
- What it returns: the Respond to Webhook node.
- Whether it handles binary data, and how long a run takes.

Where the keys hide: Switch or router nodes (the field they branch on, such as `$json.body.action`), AI or agent nodes (the text they read, such as `{{ $json.body.query }}`), Set nodes (fields they pull out), and sometimes the Webhook node itself.

Without inspection tools (a portable token grants artifact controls only, not n8n), ask the user: which workflow, its webhook URL, what inputs it needs, and what it sends back. If they are unsure of the input shape, ask them to run it once in n8n and share what Respond to Webhook returned.

Write the keys down, for example `{ action, query, source }`.

## Step 3: The `fabricId` golden rule

The `fabricId` is the key sent in the webhook body, and the name agents use when they run the artifact. It must be the **exact** string the workflow reads: if the workflow reads `$json.body.query`, the `fabricId` is `query`, not `search-query`, `user-query`, or `queryText`. The `label` can say anything human.

```javascript
// The workflow reads $json.body.action, $json.body.query, $json.body.source
const builder = window.batshit.builder;
const controls = document.getElementById('controls');
builder.mount(controls, builder.form.select({ label: 'What to do', fabricId: 'action',
  options: ['add', 'query', 'list', 'delete'], onChange: (value) => { state.action = value; } }));
builder.mount(controls, builder.form.text({ label: 'Search query', fabricId: 'query',
  onChange: (value) => { state.query = value; } }));
builder.mount(controls, builder.form.text({ label: 'Source name', fabricId: 'source',
  onChange: (value) => { state.source = value; } }));
```

**Adapt the artifact to the workflow; never ask the user to change their n8n expressions.** The workflow is live and may serve other systems.

## Step 4: Walk the user through it

Say what you found in plain words and let them confirm: *"Your workflow expects an action (add, query, list, or delete), a query, and a source name. I'll make a dropdown for the action and text boxes for the other two, and show its reply in a result card with Share, Save, and Download. It's a form-and-result tool, so I'd put it in the panel. Sound good?"*

## Step 5: Build it

Call the workflow through `window.batshit.complete()`; Batshit routes it to the saved webhook:

```javascript
async function triggerWorkflow(values) {
  const response = await window.batshit.complete('Execute workflow', { context: values });
  const text = response?.text ?? String(response);
  document.getElementById('output').textContent = text;
  window.batshit.storage.set('lastResult', text);
}
```

Webhook replies are buffered (no streaming), so show a loading state while it runs. Add `builder.action.standardControls({ storageKey: 'lastResult', title: 'Workflow result' })`.

Create it in one call with everything:

```json
{
  "name": "Knowledge Base Manager",
  "content": "<!DOCTYPE html>...",
  "brain_type": "n8n_workflow",
  "webhook_url": "https://your-n8n-host/webhook/...",
  "icon_ref": { "kind": "brand", "slug": "n8n-color" },
  "metadata": {
    "source_type": "n8n",
    "webhook_passthrough": true,
    "fabric_fields": [
      { "fabricId": "action", "type": "select", "label": "What to do", "options": ["add", "query", "list", "delete"] },
      { "fabricId": "query", "type": "text", "label": "Search query" },
      { "fabricId": "source", "type": "text", "label": "Source name" }
    ]
  },
  "zone": "panel",
  "mode": "published"
}
```

If Batshit runs in Docker, check which URL the app container can reach before you save the webhook (`runtime-location.md`).

## Step 6: Webhook passthrough

Without passthrough, an agent's run reaches the webhook wrapped in Batshit's envelope (`{ artifactId, prompt, context, ... }`), while most workflows read flat keys like `$json.body.query`. With `metadata.webhook_passthrough: true`, the field values **are** the webhook body, so a user's click and an agent's run both send `{ "action": "query", "query": "how does X work?" }`.

Leave it off only when the workflow was built for the Batshit envelope. It does not apply to Built-in AI artifacts.

## Step 7: Finish

1. Run it once through its `artifact:use.artifact.{slug}` ref (search `family: "artifact"`) with realistic values, and check the reply. A JSON parse error from n8n almost always means a key mismatch (`n8n-troubleshooting.md`).
2. Tell the user where it is and that agents can use it too (on for all agents by default; `fabric-and-agent-use.md` covers limiting that).

Good replies from the workflow are readable sentences: `{ "text": "Added 12 chunks from 'Q4 Report' to your knowledge base." }`, not `{ "success": true }`.
