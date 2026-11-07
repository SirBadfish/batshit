# Batshit User Docs

Welcome. These are the launch-facing user docs for Batshit.

Batshit is an alpha self-hosted AI workspace for AI agents on the models you choose, tools, artifacts, voice, Local AI and project-aware work, with n8n workflows as tools when you want them. These docs help you set it up and explain visible limitations.

Start with the [Quick start](quick-start/overview.md), and see the [alpha.4 release notes](reference/release-notes.md) for current features and limits.

## Alpha expectations

Batshit is in alpha. That means:

- Expect sharp edges, and report bugs.
- Setup is real self-hosting, not a one-click consumer app yet.
- The docs tell you when something is required, optional, advanced, or not included.

Batshit is open source under **AGPL-3.0-only**, the GNU Affero General Public License v3.0 only. The Batshit brand is protected separately, so the code license doesn't grant rights to present a fork or service as official Batshit.

Your chats, agents, prompts, workflows, artifacts, uploads, project files, generated content, and local data remain yours. Batshit integrates with n8n, which is separately licensed by n8n.

## Reporting alpha bugs

If something breaks, please open a [GitHub bug report](https://github.com/SirBadfish/batshit/issues/new?template=bug_report.yml). Clear steps and a diagnostics zip help us fix things faster.

When Batshit opens, click the bug icon under the chat bar or go to Settings -> Admin -> Diagnostics. Batshit shows a preview before download, and the diagnostics bundle is designed to exclude chats, prompts, uploads, project files, backups, saved API keys, service tokens, cookies, raw Redis data, and n8n workflow contents.

Read [Bug reports and diagnostics](troubleshooting/bug-reports-and-diagnostics.md) for the full checklist.

## Install first

If you're installing Batshit for the first time:

1. [Choose how to install Batshit](installation/choose-mac-app-or-docker.md)
2. Read [Install Mac app](installation/install-mac-app.md), [Install Docker](installation/install-docker.md), or [Install with Pinokio](installation/install-pinokio.md), depending on the path you chose.
3. Continue with [First run](installation/first-run.md).
4. Add [API keys and models](providers/api-keys-and-models.md).
5. Connect [n8n](primary-agents/connect-n8n.md) when you want workflow tools.
6. Read [Backup and restore](admin/backup-and-restore.md) before you depend on the instance.
7. Read [Updating Batshit](installation/updating-batshit.md) before installing a newer alpha release.

You don't need every feature on day one. A good first setup is:

1. Pick the Mac app, Docker, or a supported Pinokio setup.
2. Start Batshit.
3. Create the first admin account.
4. Use the first-time setup wizard: add one provider key, create one model preset, then create one Primary Agent.
5. Send a simple message.
6. Add n8n after the basic chat path works.

## Download and community

- [Download Batshit for Mac](https://github.com/SirBadfish/batshit/releases/latest)
- [Install with Docker](installation/install-docker.md)
- [Install with Pinokio](installation/install-pinokio.md)
- [Batshit on GitHub](https://github.com/SirBadfish/batshit)
- [Batshit on X](https://x.com/batshit_ai)
- [Batshit YouTube channel](https://www.youtube.com/@batshit-ai/)
- [Join the Discord](https://discord.gg/8cgK2qaN2c)

## Explore by subject

These docs are grouped by subject — everything about a feature lives in one place, with the concepts taught inline where you need them.

**Core setup**

- [Installation](installation/choose-mac-app-or-docker.md) — Mac app, Docker or Pinokio, first run, and runtime setup.
- [Updating Batshit](installation/updating-batshit.md) — backup first, then update your installation using its own update path.
- [Providers](providers/api-keys-and-models.md) — API keys and model presets.
- [Security & trust](security/overview.md) — what's safe, what isn't, and the habits that keep your instance yours.

**Agents and orchestration**

- [Primary Agents](primary-agents/overview.md) — one kind of agent on your chosen model, plus [n8n workflow tools](primary-agents/connect-n8n.md).
- [Agent DMs and wake-ups](primary-agents/agent-dms-and-wake-ups.md) — agents writing to each other, and chats Batshit starts on its own.
- [Subagents](subagents/overview.md) — specialist helpers a Primary Agent can call.
- [Groups](groups/overview.md) — multi-agent group chat with a single-speaker queue.
- [Projects](projects/overview.md) — project-aware work and file mentions.

**Capabilities**

- [Skills & Prompts](skills/portable-skills.md) — skills, prompts, and Portable Skills.
- [Tools](tools/overview.md) — tools, MCPs, CLI Tools, the Tool Grid, and [Zips](tools/zips.md).
- [Artifacts](artifacts/overview.md) — persistent workspace tools, including [agent use](artifacts/agent-use.md).
- [Clips](clips/overview.md) — reusable file and image uploads.
- [Memory & Infinite Sessions](chat/memory-and-infinite-sessions.md) — agents that remember you across chats, and sessions that live as one ongoing conversation.

**Voice and presence**

- [Voice](voice/overview.md) — speech-to-text and text-to-speech, with hands-on [Voice settings](voice/voice-settings.md).
- [3D Goons](goons/overview.md) — expressive 3D avatars, with [setup and packages](goons/setup-and-packages.md).

**Runtimes and operations**

- [Local AI](local-ai/overview.md) — Ollama, LM Studio, oMLX, and the other programs that run models on your own hardware.
- [Judge Juice](judge-juice/overview.md) — optional cloud judgments from TypeSafe's Jev model, off by default, with every call shown in the Execution Viewer.
- [Chat](chat/execution-viewer.md) — the chat workspace, including the Execution Viewer.
- [Admin](admin/backup-and-restore.md) — backup and restore.

A lot of these are genuinely new ideas — Zips, Clips, the Tool Grid, Group Chat's single-speaker queue, the Execution Viewer, Goons. If a concept is unfamiliar, that's expected; the page explains why it exists before how to use it.

## Troubleshooting

Use these when something isn't behaving the way the setup docs describe:

- [Docker troubleshooting](troubleshooting/docker.md)
- [n8n troubleshooting](troubleshooting/n8n.md)
- [Agents and tools troubleshooting](troubleshooting/agents-and-tools.md)
- [Voice and Local AI troubleshooting](troubleshooting/voice-local-ai.md)
- [Backup and restore troubleshooting](troubleshooting/backup-restore.md)
- [Bug reports and diagnostics](troubleshooting/bug-reports-and-diagnostics.md)

## Reference

For checking exact terms, ports, template locations, and configuration names:

- [Glossary](reference/glossary.md)
- [Ports and URLs](reference/ports-and-urls.md)
- [Environment variables](reference/env-vars.md)
- [Templates](reference/templates.md)
- [Portable Skill downloads](reference/portable-skills.md)
- [LLM map](reference/llms.txt)

## Core concepts at a glance

Every Primary Agent runs in Batshit on the saved model you pick: an API key (the simplest first path), a Local AI runtime, your ChatGPT plan or your Claude plan.

n8n is the workflow automation and tool platform: your agents call n8n workflows as tools, and an n8n workflow can wake an agent.


n8n is the workflow automation and tool platform: agents call n8n workflows as tools, and an n8n workflow can wake an agent.

Subagents are specialist helpers a Primary Agent can call. Full detail in [Primary Agents](primary-agents/overview.md) and [Subagents](subagents/overview.md).

## Current local ports

The launch-facing browser defaults:

| Service | Browser or host URL |
| --- | --- |
| Batshit app (Mac app companion) | `http://127.0.0.1:5620` |
| Batshit app (Docker host) | `http://localhost:5620` |
| Batshit app (source-checkout dev host) | `http://localhost:5621` |
| batshit-server | `http://localhost:5600` |
| n8n | `http://localhost:5678` |

Docker has more than one kind of "localhost." If something works in your browser but fails from inside Batshit, check whether the caller is your browser, the app container, n8n, batshit-server, or a sidecar. The full caller-by-caller table lives in [Ports and URLs](reference/ports-and-urls.md).

## Mac app and Docker are peers

Batshit has two first-class local setup styles:

- **Mac app** opens `Batshit.app`, shows Runtime Doctor, and starts/checks the local Batshit runtime on your Mac. After it starts, `http://127.0.0.1:5620` also opens in a normal browser against the same instance and data.
- **Docker** runs the core Batshit stack in Docker Compose. It's more contained and reproducible, but some host-local runtimes need explicit sidecars, host operators, or "connect existing" setup.

Neither path is magically safer. Docker gives clearer boundaries for the core app stack; the Mac app gives more direct access to your machine. For agent command execution, prefer sandboxed Agent Mode when it's available, and avoid importing untrusted tools, skills, workflows, artifacts, or MCP gateways.

## Source rule

These pages are the canonical public UserDocs source. The generated site at `docs.batshit.ai`, raw Markdown copies, LLM text bundles, and template downloads are all generated from this folder.

The official n8n template under `docs/user-docs/user-templates/batshit-official-n8n-workflow-templates/` is the current public-safe workflow template. If a guide, template, or setup note isn't linked from this index or the [Templates](reference/templates.md) page, treat it as outside the public UserDocs set.
