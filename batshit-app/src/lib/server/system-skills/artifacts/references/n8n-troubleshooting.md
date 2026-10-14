# n8n Artifact Troubleshooting

**Load when:** an n8n workflow artifact misbehaves (a JSON parse error, one action works and another fails, an empty or unreadable reply), you are about to lean on the n8n Instance MCP, or you want ideas for what an n8n artifact can do. The build itself is in `brain-n8n.md`.

## `fabricId` mismatches: the first suspect

**"Unexpected end of JSON input"** (or any JSON parse error from n8n) almost always means a key mismatch:

1. The artifact sent a key the workflow does not read (`body.search-query` when it reads `body.query`).
2. The workflow got `undefined` for that key.
3. An AI node got an empty input, called its model with no prompt, got an empty body, and `JSON.parse("")` threw.

To fix it:

1. Inspect the workflow (Instance MCP, or ask the user).
2. List every `$json.body.*` key it reads.
3. Compare each with the artifact's `fabricId`s.
4. Fix every place the key lives in the artifact: the Builder Kit field's `fabricId`, the `metadata.fabric_fields` entry, and any page code that builds the body by hand.
5. Save with `sys.artifact.update` (`content` plus `expectedVersion`) or `apply_patch`, then run it again.

**"List works but query fails"** is the classic per-branch mismatch: the `list` branch never reads the bad key, so it succeeds; the `query` branch does, gets `undefined`, and fails. Inspect that branch's nodes.

Fix the `fabricId` in the artifact, **never** the `$json.body.*` expression in n8n.

## Reply format

- Plain text (`Content-Type: text/plain`) is shown as it is.
- JSON with a `text` or `response` field has that field shown.
- Webhooks do not stream; replies arrive whole.

Ask for a readable confirmation from Respond to Webhook: `{ "text": "Added 12 chunks from 'Q4 Report' to your knowledge base." }` is good; `{ "success": true }` or `{ "status": "ok" }` tells the user nothing.

## Passthrough surprises

- The workflow sees `{ artifactId, prompt, context, ... }` instead of its own keys: turn on `metadata.webhook_passthrough: true`.
- The workflow was built for that envelope and now sees flat keys: turn passthrough off for it.

## Instance MCP limits

Use the n8n Instance MCP to **find and inspect** workflows; artifacts **run** them through their webhook URL.

1. **Binary data flooding:** a workflow that handles images or files returns all its internal execution data through MCP, not just the final output; a 600-character reply can become 200,000+ tokens. Artifacts are unaffected (they use the webhook), but running such a workflow through MCP's execute tool is expensive.
2. **5-minute limit:** runs longer than five minutes are killed.
3. **Text-only input:** MCP cannot send files to a workflow (a webhook can).
4. **Read-only:** MCP cannot create, edit, or activate workflows.
5. **Two opt-ins:** MCP must be on for the n8n instance and for each workflow, so not every workflow is visible.

## Webhook unreachable

A webhook URL that works from the user's browser can still fail from Batshit, especially when Batshit runs in Docker (`localhost` differs per container). Load `runtime-location.md` and check the URL from the app's side.

## Ideas

- **Knowledge-base upload:** paste text or a URL; n8n chunks, embeds, and stores it, then answers "Added 12 chunks." An agent can drop its research findings in the same way.
- **Multi-channel notifications:** channel (Email, Slack, Discord, SMS), recipient, and message; n8n routes it and confirms delivery. Agents send alerts without loading notification tools.
- **Database questions:** a plain-language question; n8n turns it into SQL, runs it, and returns a clean answer, keeping raw rows out of the chat.
- **Document generator:** template type, client, and details; n8n fills the template, makes a PDF, optionally emails it, and returns a link.
- **Data cleanup:** paste messy CSV, JSON, or text; n8n normalizes, dedupes, and categorizes it, and returns the clean result.
