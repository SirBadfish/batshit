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

## Instance MCP: capabilities and the artifact boundary

For an artifact build, use the n8n Instance MCP to **find and inspect** an existing working workflow; artifacts **run** it through the saved webhook URL. Available MCP execution, test, edit, or publish tools do not authorize using them as part of the build. Those actions need a separate explicit user request and the appropriate tool access; follow `brain-n8n.md` for artifact readiness.

**Version scope:** the facts below were checked against n8n **2.35.4**. Inspect the connected instance's discovered tool schemas before relying on them. Batshit's optional Docker n8n/runner defaults are separately pinned to **2.22.1**; do not assume they expose the same tools or behavior.

1. **Execution is asynchronous:** `execute_workflow` returns an execution ID and `started` status without waiting for completion. That is not a completed result or a universal five-minute run limit.
2. **Execution data is opt-in:** `get_workflow_execution` returns metadata only by default. `includeData: true` can return large node inputs/outputs; use `nodeNames` and `truncateData` to narrow a necessary read. The item limit does not bound each item's byte size or strip embedded binary content. Artifact replies still come from Respond to Webhook.
3. **Test timeout is separate:** `test_workflow` waits for its test run, with `timeout` defaulting to **300 seconds**, maximum **3600 seconds**. Pin data does not make all nodes harmless: credential-free command/file nodes can still act for real. Do not start a test merely to inspect a workflow.
4. **Authoring exists:** this version includes `update_workflow` and `publish_workflow` (activate), subject to n8n permissions. Availability is not permission to change the user's workflow.
5. **Inputs are structured data:** the execution schema accepts chat text, form data, or webhook JSON/headers/query; it provides no binary-file upload channel. Use the workflow's supported webhook upload contract for files.
6. **Access is tool-specific:** the instance needs MCP enabled and valid authentication. In 2.35.4, detail/execution/update/publish access also checks workflow permissions and **Available in MCP**; a search result alone does not prove those operations are allowed.

## Webhook unreachable

A webhook URL that works from the user's browser can still fail from Batshit, especially when Batshit runs in Docker (`localhost` differs per container). Load `runtime-location.md` and check the URL from the app's side.

## Ideas

- **Knowledge-base upload:** paste text or a URL; n8n chunks, embeds, and stores it, then answers "Added 12 chunks." An agent can drop its research findings in the same way.
- **Multi-channel notifications:** channel (Email, Slack, Discord, SMS), recipient, and message; n8n routes it and confirms delivery. Agents send alerts without loading notification tools.
- **Database questions:** a plain-language question; n8n turns it into SQL, runs it, and returns a clean answer, keeping raw rows out of the chat.
- **Document generator:** template type, client, and details; n8n fills the template, makes a PDF, optionally emails it, and returns a link.
- **Data cleanup:** paste messy CSV, JSON, or text; n8n normalizes, dedupes, and categorizes it, and returns the clean result.
