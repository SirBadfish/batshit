# n8n troubleshooting

This page covers Batshit and n8n integration problems.

Default launch-facing URLs:

- Batshit app, Mac app browser companion: `http://127.0.0.1:5620`
- Batshit app, Docker host: `http://localhost:5620`
- Batshit app, source-checkout dev host: `http://localhost:5621`
- batshit-server, Mac/Docker host: `http://localhost:5600`
- batshit-server, source-checkout dev host: `http://localhost:5610`
- n8n: `http://localhost:5678`
- Docker internal app URL: `http://app:3000`
- Docker optional n8n profile internal URL: `http://n8n:5678`

## Workflow import fails

Try the n8n UI import first. If it fails:

- Make sure you're importing a workflow JSON file, not a README.
- Check that the file is from `docs/user-docs/user-templates/`.
- Use the official Primary/Subagent templates first.
- If using CLI import, use an n8n version that supports current workflow imports.

Advanced CLI shape:

```sh
n8n import:workflow --input /path/to/template.json
```

After CLI import, still open the workflow in n8n and configure credentials manually.

## Workflow runs in n8n but Batshit doesn't stream

First, confirm the workflow uses the current native official Primary template:

- Webhook node Response Mode is `Streaming`.
- The native AI Agent node has streaming enabled.
- The Batshit agent uses the Production webhook URL, not the Test URL.
- n8n can reach the Batshit URL the workflow uses.

Native n8n may not show true provider-token time-to-first-token streaming in Batshit. It can buffer until the workflow response is ready, then Batshit replays the returned chunks. If the final response appears normally after the workflow finishes, that's not by itself a broken setup.

Then check the scoped native-tool token path:

1. Open the Batshit Tools node in n8n.
2. Confirm it does not use a saved Header Auth credential.
3. Confirm it sends `x-batshit-native-tool-token`.
4. Confirm the header value reads `batshit_native_tool_token` from the webhook payload.

Then check the Batshit Tools URL:

| n8n placement | Batshit Tools URL |
| --- | --- |
| Local n8n calling Mac app Batshit | `http://127.0.0.1:5620/api/native-tools/dispatch` |
| Local n8n calling source-checkout dev Batshit | `http://127.0.0.1:5621/api/native-tools/dispatch` |
| Optional Docker n8n profile calling the Docker app | `http://app:3000/api/native-tools/dispatch` |
| Existing host n8n calling Docker Batshit | `http://127.0.0.1:5620/api/native-tools/dispatch` |

If the n8n execution says `ECONNREFUSED ::1:5620` or `ECONNREFUSED ::1:5621`, n8n resolved `localhost` to IPv6 loopback. Use `127.0.0.1` for n8n server-side Batshit callback/tool URLs, or restart n8n through Batshit's launcher so it receives that callback base automatically. If n8n calls the wrong URL successfully but Batshit never receives the stream or tool calls, it may be calling a different Batshit instance.

## Mac app n8n sheet shows a secure-cookie warning

Local n8n may reject secure cookies inside the Mac app WebView and warn about insecure URLs or Safari. Open n8n in a normal browser from the sheet instead — Batshit can still call the webhook from the Mac app, and the browser window can run test-mode executions.

For a local-only n8n you own, setting `N8N_SECURE_COOKIE=false` can also remove that warning. Don't use that setting for a public or HTTPS n8n instance.

## Webhook URL doesn't work in Batshit

Use the n8n Production URL, not the Test URL, for active Batshit agents. Check that:

- the workflow is active
- the Webhook node has the expected path
- the Batshit agent type is `n8n`
- the Webhook URL is pasted into the Batshit agent's Webhook URL field
- if the Docker n8n profile publishes on a custom host port, the browser-facing webhook URL uses that host port

For the optional Docker n8n profile, Batshit may show browser-facing webhook URLs using `N8N_WEBHOOK_URL`, `WEBHOOK_URL`, or `N8N_EDITOR_BASE_URL`, while server-side calls use `http://n8n:5678`. That split is expected.

## n8n Primary Agent responds but tools don't render

Common causes:

- The workflow isn't using the current native Primary template.
- The workflow is missing the Batshit Tools HTTP Request Tool.
- The Batshit Tools node is missing `x-batshit-native-tool-token`.
- The Native Tools URL is wrong for the caller.
- The tool action name is wrong.
- `fetch_zip` is being attempted from a subagent run or a non-`n8n` Primary Agent context.

Current n8n Primary templates use n8n's native AI Agent node. Batshit hydrates execution details after the run when the live stream doesn't include every intermediate-step detail.

## n8n Primary Agent can't call a Subagent

An `n8n` Primary Agent can only call an assigned in-workflow Subnode Subagent that you explicitly wired into the Primary workflow. It cannot use the standalone n8n Workflow Subagent webhook. If no matching subnode subagent is assigned and wired, the Primary Agent should answer that it has no subagents to call.

Assigned Subnode Subagents execute through n8n's native AI Agent Tool node. The default Primary template intentionally doesn't ship with a connected Subnode Subagent tool, because connected tools are visible to the model.

For the add-on snippet, the example assigned subnode subagent slug is `n8n_subnode_subagent` unless you intentionally edited the workflow and every matching expression. The slug in n8n must match the current exact Batshit subagent slug. Batshit won't silently rewrite duplicate slugs; if one is already taken, choose another or delete/rename the original.

## Provider node fails in n8n

Provider credentials for n8n workflows live in n8n. Fix checklist:

- Open the failing model/provider node in n8n.
- Select a valid n8n credential.
- Test that credential in n8n if the node supports it.
- Confirm the model ID exists for that provider.
- Confirm the workflow's Model Selector routes to a node with credentials.
- Run the workflow directly in n8n with a small input.

Saving a provider key in Batshit doesn't automatically create an n8n credential.

## n8n Workflow Subagent isn't called

Check the pairing: `n8n` Primary Agents use n8n Subnode Subagents inside the Primary workflow, while `API` and `CLI` Primary Agents use n8n Workflow Subagents.

If the parent is `API` or `CLI`:

1. Create a Subagent with type `n8n Workflow Subagent`.
2. Paste the Production webhook URL.
3. Assign that Subagent to the Primary Agent.
4. Give the Subagent a clear description so the Primary Agent knows when to call it.
5. Send a prompt that explicitly asks for that specialty.

If the parent is `n8n`, use the subnode/tool-node pattern inside the Primary workflow instead of a separate workflow subagent.

## n8n Subagent has no tools

Check the `Batshit Subagent Tools` node:

- The Native Tools URL matches the caller.
- `x-batshit-native-tool-token` forwards the scoped token from the webhook payload.
- `x-batshit-user-id` is present.
- `actor_type` is `subagent` in the request body context.
- `parent_agent_id` is present when needed.

Subagents have their own tool scope. They don't automatically inherit every Tool Grid choice from the Primary Agent.

## n8n API key or Instance MCP doesn't work

Batshit's n8n API/MCP settings are optional and separate from basic webhook chat. Use them when you want Batshit to inspect workflows, hydrate Execution Viewer details, stop running n8n executions from Batshit's Stop button, or use n8n's instance-level MCP features.

Check:

- The n8n API URL is reachable from Batshit.
- In Docker, host n8n is usually `http://host.docker.internal:5678` from the app container; the optional Docker n8n profile is `http://n8n:5678`.
- The n8n API key is current.
- If your n8n instance asks for API-key scopes, include `execution:list`, `execution:read`, `execution:stop`, `workflow:list`, and `workflow:read`.
- The n8n Instance MCP token is current if using that feature.

Webhook chat can work even when n8n API/MCP features aren't configured.

## Batshit Stop button doesn't stop n8n

For native `n8n` Primary Agents, Batshit first stops the visible chat stream, then uses the saved n8n API key to find the matching running execution and ask n8n to stop it.

If Batshit says n8n denied the stop request, the saved n8n API key can read executions but can't stop them — create or replace the key with `execution:stop` permission, then save it again in Batshit Settings → API Keys. If Batshit says no matching running execution was found, the workflow may have already finished, the saved webhook URL may not match the active workflow path, or execution data may not be available yet.

## Optional Docker n8n profile cookie/login confusion

n8n cookies can collide if two n8n instances are both opened as `localhost` in the same browser. Fix options: stop one instance, use a different host-published port, open one as `127.0.0.1` instead of `localhost`, or use a separate browser profile. This is a browser cookie issue, not a Batshit auth issue.

## Existing host n8n calling Docker Batshit

Use the host-published Batshit app URL:

```text
http://127.0.0.1:5620
```

For current official templates, make sure host n8n forwards `batshit_native_tool_token` as `x-batshit-native-tool-token`.

## n8n executions succeed but the Batshit agent record is wrong

Check the Batshit agent settings:

- Agent type is `n8n`.
- Webhook URL is the current Production URL.
- Workflow/editor URL points to the current n8n workflow.
- Agent ID or webhook path values match what the template expects.
- Assigned subagents match the workflow shape.

If you duplicated an n8n workflow, copy the new Production URL into Batshit. Don't assume the old agent record follows the duplicate.

## Backups didn't restore n8n workflows

Batshit backups don't silently include external n8n workflows or credentials. After restoring Batshit:

1. Restore or re-import your workflows in n8n.
2. Recreate n8n credentials if needed.
3. Confirm workflow URLs.
4. Update Batshit agent/subagent webhook URLs if they changed.
5. Re-test the restored workflow from Batshit.

Use n8n's own export/backup process for n8n data.

## Safe n8n rules

- Read imported workflows from untrusted sources before activating them.
- Keep provider credentials in n8n for n8n workflows.
- Keep Batshit provider keys in Batshit for `API` agents.
- Don't expose n8n webhooks publicly without auth/rate-limit thinking.
- Test each imported workflow with a small prompt before using it for real work.
