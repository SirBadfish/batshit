# First run

This guide starts after Batshit is running through either the Mac app or Docker path.

Open Batshit through the path you chose.

Mac app:

```text
http://127.0.0.1:5620
```

Docker:

```text
http://localhost:5620
```

## Create the first admin account

On a fresh instance, Batshit shows a setup screen. Create the first admin account with:

- Email
- Display name
- Password (at least 10 characters)

This is a single-user-per-instance app for alpha launch. The admin account is for the person running this instance.

After setup, Batshit logs you in and opens the main workspace with the first-time setup wizard. Each step opens the matching Settings panel; close Settings after each step to return to the wizard. The wizard walks you through the right order:

1. Add one or more AI provider API keys.
2. Create at least one saved Model Preset.
3. Create your first Primary Agent.

You can add more keys, Model Presets, and agents later. The first agent is only a starter; you can rename, edit, or delete it any time. After the third step, close the wizard, send a test message, then use Settings → Agents to tune the starter agent.

## Confirm the core services

You should be able to reach:

| Service | URL |
| --- | --- |
| Batshit app, Mac app browser companion | `http://127.0.0.1:5620` |
| Batshit app, Docker host | `http://localhost:5620` |
| Batshit app, source-checkout dev host | `http://localhost:5621` |
| batshit-server health, Mac/Docker host | `http://localhost:5600/health` |
| batshit-server health, source-checkout dev host | `http://localhost:5610/health` |
| n8n, if you use it | `http://localhost:5678` |

If the UI opens but file uploads, Clips, Goons, or helper tools fail, check batshit-server first.

## Do the minimum useful setup

For your first successful chat:

1. Use the first-time setup wizard to open API Keys.
2. Add one provider API key, or configure Local AI separately.
3. Use the wizard to open Models.
4. Create a saved Model Preset for that provider or Local AI runtime.
5. Use the wizard to open Agents.
6. Create one `API` Primary Agent.
7. Pick the saved Model Preset.
8. Close the wizard and send a simple message.

`API` is the simplest first chat path — it doesn't require n8n workflow wiring or CLI login.

## Understand the two Primary Agent types

| Agent type | Best first use | Needs |
| --- | --- | --- |
| `API` | Direct model-provider chat, tools, voice features, and normal first setup | Provider API key or Local AI runtime |
| `CLI` | You want Codex or Claude Code style CLI work inside Batshit | CLI installed and logged in |

You can use both over time. You only need one on day one.

## Create a simple `API` Primary Agent

1. Open Settings → Agents, or use the Agents step in the first-time setup wizard.
2. Choose Create Primary Agent if you're starting from the empty Agents page.
3. Select Primary Agent.
4. Set the type to `API`.
5. Give it a name.
6. Pick your saved Model Preset.
7. Save, or wait for the settings panel to autosave.
8. Select the agent in chat.
9. Send: `Say hello and tell me what model you are using.`

If the model responds, your core provider path is working.

## Add n8n after basic chat works

n8n is one of Batshit's most important parts, but it adds another runtime and credentials surface. Use it when you want:

- n8n workflow tools called by `API` or `CLI` agents
- n8n-managed provider credentials, workflow logic, or integrations
- n8n Workflow Subagents

Read [Connect n8n](../primary-agents/connect-n8n.md) before creating n8n Workflow Subagents or adding n8n workflow tools.

## Add CLI agents after install and login work

`CLI` agents need the CLI installed, then a real CLI login.

Two supported ways to get the CLI installed:

- **One-click managed install (recommended):** open the agent in Settings; in the model section, Batshit shows an install card for Codex CLI and Claude Code CLI. Click Install and Batshit downloads and manages an official verified copy. This is the normal path for Docker installs.
- **Bring your own:** if you already have `codex` or `claude` installed, Batshit finds it automatically and keeps using it.

After install, sign in. Mac app or host Codex example:

```sh
codex login
codex login status
```

Docker Codex example (Batshit shows the exact copyable command in Agent Settings, including the managed install path when needed):

```sh
docker compose --env-file .env.docker exec app /home/batshit-cli/.batshit/installs/cli/bin/codex login --device-auth
```

If you started Docker with the n8n profile, the command includes `--profile n8n`.

Provider API keys saved in Settings don't replace CLI login. They're different auth paths.

## Set a Project workspace

Projects let Batshit agents understand and work with a folder.

Mac app:

- Use a real host path, such as `/Users/you/projects/my-app`.

Docker:

- Mount the host folder through `BATSHIT_WORKSPACE_MOUNT`.
- Use `/workspace` paths inside Batshit.

Project files aren't included in Batshit app backups. Keep your code in Git or your own backup system.

## Safe agent defaults

For first runs:

- Prefer sandboxed Agent Mode when command execution is involved.
- Avoid full-permission local shell access until you understand what the agent can do.
- Use trusted providers, n8n workflows, MCP gateways, and Skills.
- Enable only Skills you trust — an enabled Skill can be chosen by the agent when it clearly fits your request.
- Don't paste secrets into chat when Settings → API Keys has a proper saved-key field.
- Don't import random n8n workflows, Artifacts, MCPs, or Skills from strangers without reading them.

Batshit fails loudly when a runtime is unavailable or a token is wrong. A clear error is a setup clue, not a reason to start changing random settings.

## First-run checklist

- [ ] Batshit opens at `http://127.0.0.1:5620` (Mac app), `http://localhost:5620` (Docker), or `http://localhost:5621` (source-checkout dev).
- [ ] batshit-server health opens at `http://localhost:5600/health` (Mac/Docker) or `http://localhost:5610/health` (source-checkout dev).
- [ ] First admin account exists.
- [ ] One provider key or Local AI runtime is configured.
- [ ] One Model Preset exists.
- [ ] One `API` Primary Agent can reply.
- [ ] Backup export has been tested once after setup.
- [ ] n8n is connected only after the basic direct path works.
- [ ] CLI login is done before trying `CLI` agents.

Next: [API keys and models](../providers/api-keys-and-models.md)
