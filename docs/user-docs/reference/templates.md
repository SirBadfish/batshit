# Templates

This page lists the public-safe template files published by the docs site under `/user-templates/`.

## Batshit Anime Hair Studio template

Use [Batshit Base Female Hair Template v1](/user-templates/batshit-anime-hair-studio/Batshit-Base-Female-Hair-Template-v1.ahs) to create Hair for the first-party Base Female Goon in Anime Hair Studio. Duplicate the project, author and export the finished hairstyle as OBJ, then select the OBJ and saved `.ahs` together in **Goon Editor -> Hair -> Import Hair**.

The `.ahs` project is optional calibration data, not Hair geometry. Batshit recognizes the unmodified head/scalp calibration after ordinary project saves and Hair edits, but a changed or independently calibrated scalp uses the visible general-fit path. An `.ahs` file cannot be imported without its exported OBJ.

[Anime Hair Studio](https://github.com/Ludetools/Animehairstudio) remains a separate application governed by its own license. Batshit publishes only its own template project data and embedded Batshit calibration; it does not bundle Anime Hair Studio or its source code.

## n8n template rule

Import workflow templates in n8n. Batshit does not silently provision n8n workflows, credentials, provider keys, or model nodes for the user.

For n8n workflows:

- Create credentials in n8n.
- Configure provider/model nodes in n8n.
- Keep n8n provider credentials in n8n. Batshit Settings -> API Keys does not copy provider keys into n8n.

## Wake an agent on a schedule with n8n

Batshit has one official n8n template today. It has n8n call a Batshit [wake-up webhook](../primary-agents/agent-dms-and-wake-ups.md#wake-up-webhooks) on a timer, so an agent starts a chat for you.

| File | Workflow name | Use |
| --- | --- | --- |
| [`batshit-n8n-wake-agent-on-schedule.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-wake-agent-on-schedule.json) | Batshit - Wake an Agent on a Schedule | A Schedule Trigger, a **Configure** node you edit, and one HTTP Request that wakes one Batshit agent. |

For a trigger that is only time, Batshit's own **Schedules** need no n8n, no webhook and no token. Use this template when you already run your automations in n8n, or when the trigger lives outside Batshit.

The file is intended to be public-safe. It does not include credential IDs, secret values, source instance ownership metadata, source instance version metadata, or private local port assumptions. Import it through the n8n UI.

### Credential

After import, create or select this credential in n8n:

| Credential | Needed for | Value |
| --- | --- | --- |
| Header Auth | The **Wake the Batshit Agent** node | Name `Authorization`, value `Bearer <your wake-up webhook token>`. Create the webhook and copy its token in Batshit first. The token is shown once. |

Provider credentials are not needed. The template has no model node.

### Batshit URL

The template reads `BATSHIT_FRONTEND_URL` from the n8n environment and falls back to `http://127.0.0.1:5620`. Set the **Configure** node's `batshit_base_url` to the address n8n can actually reach:

| n8n location | Batshit URL |
| --- | --- |
| Local n8n beside Mac app Batshit | `http://127.0.0.1:5620` |
| Local n8n beside source-checkout dev Batshit | `http://127.0.0.1:5621` |
| Optional Docker n8n profile | `http://app:3000` |
| Host-managed n8n calling Docker Batshit | `http://127.0.0.1:5620` |

Use `127.0.0.1`, not `localhost`, when n8n is the caller.

### Import checklist

- The workflow imports without missing-node errors.
- The Header Auth credential is selected on **Wake the Batshit Agent**.
- `wake_hook_id` in **Configure** is the id of your Batshit wake-up webhook.
- `batshit_base_url` matches where n8n runs.
- The recipient agent has Agent DMs turned on.
- The workflow is activated in n8n before you test it.

## Backup and sharing notes

Batshit app backups do not silently include external n8n workflows or n8n credentials. Export n8n workflows from n8n when you need an n8n backup.

Before sharing a workflow export:

- Remove credential IDs.
- Remove secret values.
- Remove source instance metadata that identifies a private n8n instance.
- Replace local paths and private URLs with placeholders.
- Confirm the workflow uses current Batshit names and current ports.
