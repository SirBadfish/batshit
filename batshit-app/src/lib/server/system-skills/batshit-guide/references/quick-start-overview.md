# Quick start

The fastest path from zero to your first message in Batshit: install, create an admin account, add one model source, make one `API` Primary Agent, and send. A walkthrough video is planned to sit at the top of the install experience; until then, this page is the shortest route in words.

This is the fast lane. The [Installation](../installation/choose-mac-app-or-docker.md) section is the thorough version with every option, tradeoff, and troubleshooting note. Use this page to get a working chat quickly, then go deeper where you need to.

## Pick your install in one line

- **On a Mac?** Use the Mac app. You open `Batshit.app`, let Runtime Doctor start the local services, then open Batshit. Full steps: [Install Mac app](../installation/install-mac-app.md).
- **On Windows or Linux?** Use Docker. You clone the repo, set two secrets, and run one launcher. Full steps: [Install Docker](../installation/install-docker.md).

Both paths are first-class peers — neither is a lesser fallback. If you want the full comparison before deciding, read [Choose Mac app or Docker](../installation/choose-mac-app-or-docker.md). Otherwise, the one-liner above is enough to start.

Batshit is alpha self-hosting, not a one-click consumer app yet. Expect a few real setup steps and honest error messages when something needs configuring.

## The five steps to a first message

Once Batshit is installed and running, this is the whole fast path:

1. **Start Batshit and open it.**
   - Mac app: open `Batshit.app`, use **Start Runtime**, then **Open Batshit**. It opens at `http://127.0.0.1:5620`.
   - Docker: run `./start-docker.sh`, then open `http://localhost:5620`.
2. **Create the first admin account.** A fresh instance shows a setup screen. Enter an email, a display name, and a password of at least 10 characters. This is a single-user-per-instance app, so this account is yours.
3. **Use the first-time setup wizard.** It opens the right settings areas in order: API Keys, Models, then Agents. You can add one key or several, create one starter preset and agent, and add more later.
4. **Add one model source.** You need exactly one of these:
   - A provider API key (the simplest start) — use the wizard or open Settings → API Keys, add a key for a provider like OpenAI, Anthropic, or Google, then create a saved model preset in Settings → Models. Details: [API keys and models](../providers/api-keys-and-models.md).
   - A Local AI runtime — if you'd rather run a model on your own machine, configure it in Settings → Local AI and create a preset that uses it. Details: [Local AI](../local-ai/overview.md).
5. **Create one `API` Primary Agent.** Use the wizard or open Settings → Agents, create a Primary Agent, set its type to `API`, give it a name, and pick the model preset you just saved.
6. **Send a message.** Select the agent in chat and try: `Say hello and tell me what model you are using.` If the model answers, your core path works.

That's it. You now have a working Batshit chat.

## Why `API` first

Batshit has three Primary Agent types — `n8n`, `API`, and `CLI` — and they're peer choices, not quality tiers. For a first message, `API` is the shortest route because Batshit talks straight to a model provider (or a Local AI runtime). It doesn't need an n8n workflow wired up or a CLI installed and logged in.

You can add the other types later when you want them:

- `n8n` when you want the main agent to run inside an n8n workflow — see [Connect n8n](../primary-agents/connect-n8n.md).
- `CLI` when you want a managed Codex or Claude Code agent inside Batshit.

The full picture lives in [Primary Agents](../primary-agents/overview.md).

## What to do right after

Once your first agent replies, a couple of small habits pay off fast:

- **Test a backup once.** Export a normal backup from Settings → Admin so you know recovery works before you depend on the instance. See [Backup and restore](../admin/backup-and-restore.md).
- **Keep early agent runs safe.** Prefer sandboxed Agent Mode when command execution is involved, and don't import workflows, tools, Skills, or Artifacts from strangers without reading them.

## Where to go next

- Full install detail and tradeoffs: [Choose Mac app or Docker](../installation/choose-mac-app-or-docker.md)
- Step-by-step first session: [First run](../installation/first-run.md)
- Model providers and presets: [API keys and models](../providers/api-keys-and-models.md)
- Everything about agents: [Primary Agents](../primary-agents/overview.md)
