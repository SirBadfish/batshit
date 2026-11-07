# n8n troubleshooting

This page covers n8n workflows that Batshit agents call as tools, and n8n workflows that call Batshit.

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
- Use the official wake-up template, or a workflow exported from n8n.
- Check that your n8n version supports the current workflow format.
- For CLI import, use:

```sh
n8n import:workflow --input /path/to/template.json
```

After import, open the workflow and configure credentials manually.

## My n8n Workflow Subagent stopped working

n8n Workflow Subagents were removed. A saved one no longer runs and no longer appears in Settings, and Batshit does not convert it. Your n8n workflow is still in n8n and still works. Publish it as a tool, or rebuild the specialist as a Subagent. See [Connect n8n](../primary-agents/connect-n8n.md).

## n8n cannot reach Batshit

This applies to a workflow that calls a Batshit wake-up webhook, such as the official wake-up template. The URL is the Batshit address plus `/api/wake/<webhook id>`.

| n8n placement | Batshit URL |
| --- | --- |
| Local n8n calling Mac app Batshit | `http://127.0.0.1:5620` |
| Local n8n calling source-checkout Batshit | `http://127.0.0.1:5621` |
| Optional Docker n8n profile | `http://app:3000` |
| Existing host n8n calling Docker Batshit | `http://127.0.0.1:5620` |

If n8n reports `ECONNREFUSED ::1:5620` or `::1:5621`, it resolved `localhost` to IPv6. Use `127.0.0.1` for local server-to-server calls, or launch n8n through Batshit's launcher so it receives the correct base URL.

If a request succeeds against the wrong Batshit instance, check the template's `batshit_base_url` and the `BATSHIT_FRONTEND_URL` value in the n8n environment before changing credentials.

## Provider node fails

Provider credentials for n8n workflows live in n8n:

- Open the failing model node.
- Select or create a valid n8n credential.
- Confirm the model ID exists for that provider.
- Run the workflow directly in n8n with a small input.

Saving a provider key in Batshit does not create an n8n credential.

## n8n API key or Instance MCP does not work

Batshit's n8n API/MCP settings are optional and separate from workflow execution. Use them for workflow discovery and n8n Instance MCP features.

Check:

- The n8n API URL is reachable from Batshit.
- In Docker, host n8n is usually `http://host.docker.internal:5678` from the app container; the optional Docker n8n profile is `http://n8n:5678`.
- The n8n API key is current and has workflow read access.
- The n8n Instance MCP token is current if you use that feature.

## Optional Docker n8n cookie or login confusion

n8n cookies can collide if two n8n instances are opened as `localhost` in the same browser. Stop one instance, change one host-published port, open one as `127.0.0.1`, or use a separate browser profile.

## Backups did not restore n8n workflows

Batshit backups do not include external n8n workflows or credentials. After restoring Batshit:

1. Restore or re-import workflows in n8n.
2. Recreate n8n credentials if needed.
3. Confirm the Production webhook URLs.
4. Re-test from a Primary Agent.

Use n8n's own export/backup process for n8n data.

## Safe n8n rules

- Read imported workflows from untrusted sources before activating them.
- Keep provider credentials in n8n for n8n workflows.
- Keep Batshit provider keys in Batshit for `API` agents.
- Do not expose n8n webhooks publicly without authentication and rate-limit planning.
- Test each imported workflow with a small task before using it for real work.
