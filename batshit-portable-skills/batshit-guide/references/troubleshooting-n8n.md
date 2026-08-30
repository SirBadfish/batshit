# n8n troubleshooting

This page covers Batshit workflow tools and n8n Workflow Subagents.

Default URLs:

- Mac app Batshit: `http://127.0.0.1:5620`
- Docker Batshit from the host: `http://localhost:5620`
- Source-checkout Batshit: `http://localhost:5621`
- n8n editor: `http://localhost:5678`
- Docker internal Batshit app: `http://app:3000`
- Optional Docker n8n service: `http://n8n:5678`

## Workflow import fails

Try the n8n UI import first. If it fails:

- Make sure you selected a workflow JSON file.
- Use one of the two official Workflow Subagent templates.
- Check that your n8n version supports the current workflow format.
- For CLI import, use:

```sh
n8n import:workflow --input /path/to/template.json
```

After import, open the workflow and configure credentials manually.

## Workflow Subagent does not answer

Check:

1. The workflow is active.
2. The Batshit Subagent uses the Production webhook URL, not a temporary Test URL.
3. The Subagent type is `n8n Workflow Subagent`.
4. The Subagent is assigned to an `API` or `CLI` Primary Agent.
5. The model/provider node has a valid credential.
6. n8n execution history shows the webhook request.
7. The workflow returns a result rather than waiting on an unconnected branch.

Give the Subagent a specific description so the Primary Agent knows when to call it. For a first test, explicitly ask the Primary Agent to delegate to that specialist.

## Batshit Subagent Tools returns authentication errors

Open the `Batshit Subagent Tools` HTTP Request Tool and confirm:

- Authentication is not a saved Batshit Header Auth credential.
- It sends `x-batshit-native-tool-token`.
- The header value reads `batshit_native_tool_token` from the webhook payload.
- The request context keeps `actor_type: subagent`.
- `parent_agent_id`, `subagent_id`, `session_id`, and `message_id` are present.

If `parent_agent_id` is missing, Batshit refuses the call instead of guessing a broader parent scope.

## Batshit Subagent Tools cannot reach Batshit

| n8n placement | Dispatch URL |
| --- | --- |
| Local n8n calling Mac app Batshit | `http://127.0.0.1:5620/api/native-tools/dispatch` |
| Local n8n calling source-checkout Batshit | `http://127.0.0.1:5621/api/native-tools/dispatch` |
| Optional Docker n8n profile | `http://app:3000/api/native-tools/dispatch` |
| Existing host n8n calling Docker Batshit | `http://127.0.0.1:5620/api/native-tools/dispatch` |

If n8n reports `ECONNREFUSED ::1:5620` or `::1:5621`, it resolved `localhost` to IPv6. Use `127.0.0.1` for local server-to-server calls, or launch n8n through Batshit's launcher so it receives the correct callback base.

The official templates prefer `batshit_frontend_url` from the call payload, then `BATSHIT_FRONTEND_URL`, then their platform-specific fallback. If a request succeeds against the wrong Batshit instance, check those values before changing credentials.

## Provider node fails

Provider credentials for n8n workflows live in n8n:

- Open the failing model node.
- Select or create a valid n8n credential.
- Confirm the model ID exists for that provider.
- Run the workflow directly in n8n with a small input.

Saving a provider key in Batshit does not create an n8n credential.

## Model parameters show n8n compatibility warnings

Batshit keeps a local snapshot of the parameters exposed by your n8n chat-model nodes. It refreshes that snapshot when you create or edit an n8n Workflow Subagent, and when you open that Subagent's model card after the snapshot has been stale for about a day.

If refresh fails:

- Confirm the n8n API URL is reachable from Batshit.
- Replace an expired n8n API key.
- Check the visible error on the model card.
- Use the model card's manual n8n refresh button after fixing the connection.

Compatibility marks appear only when at least one n8n Workflow Subagent exists and a local n8n matrix snapshot is available.

## Workflow Subagent has no tools

Subagents use their own Tool Grid. They do not inherit every tool from the parent Primary Agent.

Check:

- The Subagent's Tool Grid enables the needed family.
- The relevant MCP gateway or saved CLI Tool is healthy.
- `Batshit Subagent Tools` is connected to the n8n agent node.
- The request preserves the scoped native-tool token and parent context.
- The Subagent is not trying to fetch a prior Batshit Zip directly; Fetch Zip is Primary-only.

## n8n API key or Instance MCP does not work

Batshit's n8n API/MCP settings are optional and separate from workflow execution. Use them for workflow discovery, model-node compatibility refresh, and n8n Instance MCP features.

Check:

- The n8n API URL is reachable from Batshit.
- In Docker, host n8n is usually `http://host.docker.internal:5678` from the app container; the optional Docker n8n profile is `http://n8n:5678`.
- The n8n API key is current and has workflow/node-type read access.
- The n8n Instance MCP token is current if you use that feature.

A Workflow Subagent webhook can work even when optional n8n API/MCP features are not configured.

## Optional Docker n8n cookie or login confusion

n8n cookies can collide if two n8n instances are opened as `localhost` in the same browser. Stop one instance, change one host-published port, open one as `127.0.0.1`, or use a separate browser profile.

## Backups did not restore n8n workflows

Batshit backups do not include external n8n workflows or credentials. After restoring Batshit:

1. Restore or re-import workflows in n8n.
2. Recreate n8n credentials if needed.
3. Confirm the Production webhook URLs.
4. Update Batshit Workflow Subagent records if those URLs changed.
5. Re-test from an `API` or `CLI` Primary Agent.

Use n8n's own export/backup process for n8n data.

## Safe n8n rules

- Read imported workflows from untrusted sources before activating them.
- Keep provider credentials in n8n for n8n workflows.
- Keep Batshit provider keys in Batshit for `API` agents.
- Do not expose n8n webhooks publicly without authentication and rate-limit planning.
- Test each imported workflow with a small task before using it for real work.
