# Batshit User Docs

Welcome. These are the launch-facing user docs for Batshit.

Batshit is an alpha self-hosted AI workspace for people who want n8n orchestration, direct AI agents, CLI-powered agents, tools, artifacts, voice, local runtimes, and project-aware work in one place. It's powerful, broad, and still early. These docs are written to save you setup time and to be honest when a feature needs careful configuration.

## Alpha expectations

Batshit is preparing for an alpha launch. That means:

- Expect sharp edges, and report bugs.
- Setup is real self-hosting, not a one-click consumer app yet.
- The docs tell you when something is required, optional, advanced, or not included.

Batshit is planned as open source under **AGPL-3.0-only**, the GNU Affero General Public License v3.0 only. The Batshit brand is protected separately, so the code license doesn't grant rights to present a fork or service as official Batshit.

Your chats, agents, prompts, workflows, artifacts, uploads, project files, generated content, and local data remain yours. Batshit integrates with n8n, which is separately licensed by n8n.

## Install first

If you're installing Batshit for the first time:

1. [Choose Mac app or Docker](installation/choose-mac-app-or-docker.md)
2. Read either [Install Mac app](installation/install-mac-app.md) or [Install Docker](installation/install-docker.md), depending on the path you chose.
3. Continue with [First run](installation/first-run.md).
4. Add [API keys and models](providers/api-keys-and-models.md).
5. Connect [n8n](primary-agents/connect-n8n.md) when you want n8n agents or workflow tools.
6. Read [Backup and restore](admin/backup-and-restore.md) before you depend on the instance.

You don't need every feature on day one. A good first setup is:

1. Pick Mac app or Docker.
2. Start Batshit.
3. Create the first admin account.
4. Use the first-time setup wizard: add one provider key, create one model preset, then create one `API` Primary Agent.
5. Send a simple message.
6. Add n8n after the basic chat path works.

## Download, videos, and community

- [Download Batshit for Mac](https://github.com/SirBadfish/batshit/releases/download/v0.1.0-alpha.1/Batshit-0.1.0-macos-ReleaseSafe.dmg)
- [Install with Docker](installation/install-docker.md)
- [Watch the informal alpha walkthrough playlist](https://www.youtube.com/watch?v=hS3NfNPgW70&list=PLeodpgBXojRy4Ssreao79TIX7PylhiI1D)
- [Batshit on GitHub](https://github.com/SirBadfish/batshit)
- [Batshit on X](https://x.com/batshit_ai)
- [Batshit YouTube channel](https://www.youtube.com/@batshit-ai/)
- [Join the Discord](https://discord.gg/3saVHX5xn)

The alpha videos are informal and aimed at AI enthusiasts, builders, and people who have used tools like Codex before.

## Explore by subject

These docs are grouped by subject — everything about a feature lives in one place, with the concepts taught inline where you need them.

**Core setup**

- [Installation](installation/choose-mac-app-or-docker.md) — Mac app or Docker, first run, and the Docker runtime and add-ons.
- [Providers](providers/api-keys-and-models.md) — API keys and model presets.
- [Security & trust](security/overview.md) — what's safe, what isn't, and the habits that keep your instance yours.

**Agents and orchestration**

- [Primary Agents](primary-agents/overview.md) — the `n8n`, `API`, and `CLI` agent types, plus [connecting n8n](primary-agents/connect-n8n.md).
- [Subagents](subagents/overview.md) — specialist helpers a Primary Agent can call.
- [Groups](groups/overview.md) — multi-agent group chat with a single-speaker queue.
- [Projects](projects/overview.md) — project-aware work and file mentions.

**Capabilities**

- [Skills & Prompts](skills/portable-skills.md) — skills, prompts, and Portable Skills.
- [Tools](tools/overview.md) — tools, MCPs, CLI Tools, the Tool Grid, and [Zips](tools/zips.md).
- [Artifacts](artifacts/overview.md) — persistent workspace tools, including [agent use](artifacts/agent-use.md).
- [Clips](clips/overview.md) — reusable file and image uploads.

**Voice and presence**

- [Voice](voice/overview.md) — speech-to-text and text-to-speech, with hands-on [Voice settings](voice/voice-settings.md).
- [3D Goons](goons/overview.md) — expressive 3D avatars, with [setup and packages](goons/setup-and-packages.md).

**Runtimes and operations**

- [Local AI](local-ai/overview.md) — Ollama, LM Studio, and other local runtimes.
- [Chat](chat/execution-viewer.md) — the chat workspace, including the Execution Viewer.
- [Admin](admin/backup-and-restore.md) — backup and restore.
- [Resources](resources/n8n-workflow-templates.md) — n8n workflow templates and downloads.

A lot of these are genuinely new ideas — Zips, Clips, the Tool Grid, Group Chat's single-speaker queue, the Execution Viewer, Goons. If a concept is unfamiliar, that's expected; the page explains why it exists before how to use it.

## Troubleshooting

Use these when something isn't behaving the way the setup docs describe:

- [Docker troubleshooting](troubleshooting/docker.md)
- [n8n troubleshooting](troubleshooting/n8n.md)
- [Agents and tools troubleshooting](troubleshooting/agents-and-tools.md)
- [Voice and Local AI troubleshooting](troubleshooting/voice-local-ai.md)
- [Backup and restore troubleshooting](troubleshooting/backup-restore.md)

## Reference

For checking exact terms, ports, template locations, and configuration names:

- [Glossary](reference/glossary.md)
- [Ports and URLs](reference/ports-and-urls.md)
- [Environment variables](reference/env-vars.md)
- [Templates](reference/templates.md)
- [Portable Skill downloads](reference/portable-skills.md)
- [LLM map](reference/llms.txt)

## Core concepts at a glance

Batshit has three Primary Agent types — peer choices, not quality tiers:

- **`n8n`** — the main agent runs inside an n8n workflow (needs n8n, a workflow, a webhook URL).
- **`API`** — Batshit talks directly to model providers (needs a provider key or Local AI runtime). The simplest first path.
- **`CLI`** — Batshit runs a managed CLI agent like Codex or Claude Code (needs the CLI installed and logged in).

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

The official n8n templates under `docs/user-docs/user-templates/batshit-official-n8n-workflow-templates/` are the current public-safe workflow templates. If a guide, template, or setup note isn't linked from this index or the [Templates](reference/templates.md) page, treat it as outside the public UserDocs set.
