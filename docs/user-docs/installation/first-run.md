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

On a fresh instance, Batshit shows a setup screen titled **Welcome to batshit!**. Create the first admin account with:

- Email
- Display name
- Password (at least 10 characters)
- Confirm password (the same password again)

Then choose **Create Admin Account**.

This is a single-user-per-instance app for alpha launch. The admin account is for the person running this instance.

After setup, Batshit logs you in and opens the main workspace with the first-time setup wizard. Each step opens the matching Settings panel. Close Settings after each step to return to the wizard: use **Close** at the bottom of the Settings list (scroll the list down on a short window), or press Esc. The wizard walks you through the right order:

1. Add one or more AI provider API keys.
2. Create at least one saved Model Preset.
3. Create your first Primary Agent.

You can add more keys, Model Presets, and agents later. The first agent is only a starter; you can rename, edit, or delete it any time. After the third step the wizard says you're ready: choose **Close / Start chat**, send a test message, then use Settings → Agents to tune the starter agent.

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
6. Create one Primary Agent.
7. Pick the saved Model Preset.
8. Close the wizard and send a simple message.

`API` is the simplest first chat path — it doesn't require n8n workflow wiring or CLI login.

## One kind of Primary Agent

A Primary Agent runs on the saved model you pick, on any connection: an API key, a Local AI runtime, your ChatGPT plan or your Claude plan. You only need one agent on day one.

## Create a Primary Agent

1. Open Settings → Agents, or use the Agents step in the first-time setup wizard.
2. In **Create Primary Agent or Subagent**, keep **Primary Agent** selected.
3. Type a **Display Name**, then choose **Create**.
4. On the new agent's **Core** tab, pick your saved Model Preset under **Default Model**. It saves by itself.
5. Select the agent in chat.
6. Send: `Say hello and tell me one thing you can do in Batshit.`

If the model responds, your core provider path is working. Don't ask the model which model it is: models often get their own name wrong. The chat bar shows the Model Preset Batshit actually used, and the Execution Viewer shows the exact request.

## Add n8n after basic chat works

n8n is one of Batshit's most important parts, but it adds another runtime and credentials surface. Use it when you want:

- n8n workflow tools called by your agents
- n8n-managed provider credentials, workflow logic, or integrations

Read [Connect n8n](../primary-agents/connect-n8n.md) before adding n8n workflow tools.

## Add your Claude plan when you want it

To use your own Claude plan as the model for an agent or a Subagent, Batshit needs Claude Code installed and signed in with that plan.

Open **Settings → API Keys → Claude Plan**:

- **One-click managed install (recommended):** if Claude Code is not installed yet, press **Install Claude Code CLI** in the card. Batshit downloads and manages an official verified copy.
- **Bring your own:** if you already have `claude` installed, Batshit finds it. The Claude plan connection uses only the Claude Code version Batshit was tested with; if yours is different, the card says so and offers **Install Batshit-managed copy**.

Then sign in with your Claude plan. Mac app or host example:

```sh
claude auth login
```


Press **Check Again**. When the card says **Ready**, make a model preset on the **Claude Plan** connection and pick it for an agent. See [Claude plan](../providers/claude-plan.md).

Provider API keys saved in Settings don't sign Claude Code in. They're different auth paths.

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
- [ ] One Primary Agent can reply.
- [ ] Backup export has been tested once after setup.
- [ ] n8n is connected only after the basic direct path works.
- [ ] If using the Claude plan, Settings → API Keys → Claude Plan says **Ready**.

Next: [API keys and models](../providers/api-keys-and-models.md)
