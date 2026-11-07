# Release notes

## 0.1.0-alpha.4 — November 5, 2026

This update brings one agent experience across API keys, Local AI and supported ChatGPT or Claude plan connections, updated help, the complete Batshit plugin and security maintenance.

### Before upgrading

Make a [backup](../admin/backup-and-restore.md). Restore replaces current Batshit data, so inspect an archive before confirming a restore.

**Codex CLI and Claude Code CLI agents and Subagents were removed.** Leftover CLI records remain visible so you can delete them; they cannot run, be edited or silently become another kind of agent. Create a new Primary Agent or Subagent and choose a saved model. Use the ChatGPT plan connection or an OpenAI API key for ChatGPT models, or the [Claude plan connection](../providers/claude-plan.md) for your Claude plan.

Deleting a Primary Agent normally also deletes its chats: the confirmation's **Also delete its chats** box starts checked. Copy or export anything you want to keep first, or uncheck the box to keep those chats. Group chats and locked chats have their existing protection. Deleting a leftover Subagent removes its own settings, saved helper threads and owned CLI folder; older chat results remain.

The old **CLI Primary Agent System Prompt** was removed from Admin. If you customized it and want its text, copy it before upgrading. A backup carrying it can still restore the rest; Batshit leaves that retired prompt out and reports it.

**n8n Workflow Subagents were removed.** They no longer run or appear in Settings, and nothing is converted. Your n8n workflows remain in n8n and can still be called as tools or send wake-up webhooks. Recreate a specialist as an ordinary Subagent if needed. A hidden old record may still reserve its old name; choose a new name if Batshit says it is taken.

### What you can use

- **One Primary Agent and one Subagent kind.** Pick a saved model and its connection; there is no API/CLI type choice. [Subagents and Workers](../subagents/overview.md) use Batshit's tools and permissions. Up to six Workers can run at once; delegated runs have no time or tool-step limit by default, with optional specialist limits and a ten-minute stall guard.
- **Claude plan in the Mac app.** Install and sign in from Settings → API Keys → Claude Plan. Batshit runs every tool; Claude Code supplies the model. Plan usage and any account extra-usage charges remain Anthropic's. Batshit never switches to a paid API key by itself. Docker is not yet qualified for this connection.
- **Local ChatGPT sign-in.** The local Mac app and supported local Mac/Windows Pinokio flow use your own browser sign-in. Keep the browser and Batshit on the same computer; each installation needs its own connection. Docker live sign-in and remote setups remain outside the qualified guide.
- **Whiteboard and reasoning choices.** Reasoning Retention starts at Whiteboard Only with a 1,500 estimated-token board. Use the Brain menu for supported per-agent model reasoning choices. Display settings and retained context remain separate.
- **Automatic backups.** Optional Daily or Weekly backups retain two verified recovery copies. Automatic and after-update backups start off.
- **File tools and refreshed reads.** Typed File Tools starts off. Refreshed File Reads starts on where supported; it refreshes eligible reads at the beginning of a reply or hides them for that reply when refresh fails. Existing explicit choices are kept.
- **App Actions.** Give selected agents access to supported Settings changes, review protected operations and inspect uncertain outcomes. MCP setup and each later tool effect retain separate permissions. See [App Actions](../fabric/app-actions.md).
- **One complete plugin.** Download all eight skills from Settings → Plugins & shit → Plugins → Batshit → Download Plugin. The plugin has one access setting for its skills. Upgrading combines earlier built-in access: an active skill enabled for everyone enables the package for everyone; otherwise the package includes the named agents that had active built-in access. Review Plugins to narrow it. Older separate skill ZIPs remain archives.
- **Voice model lists.** Compatible catalog updates preserve your saved voice choices. Models requiring different APIs remain unavailable until supported; recorded transcription does not become continuous microphone input.

Goons retain the supported imported VRoid, Blender and Advanced/GLB package workflows, manual outfits, Hair and Scenes. This update does not offer a new bundled first-party character, native clothing-fitting workflow or spherical-eyelid method.

Download the Mac DMG and its matching checksum from the [GitHub release](https://github.com/SirBadfish/batshit/releases/tag/v0.1.0-alpha.4). See [Install Mac app](../installation/install-mac-app.md) for installation and checksum verification.
