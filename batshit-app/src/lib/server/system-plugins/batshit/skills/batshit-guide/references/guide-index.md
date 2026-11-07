# Batshit Guide complete reference index

## Reference Index

Load only what the question needs. Names are `references/<file>`.

`reference-paths.md` — exact original UserDocs paths and flat skill paths for following links inside a page.

**Start here**
- `quick-start-overview.md` — first-session tour: keys, agent, chat basics.
- `architecture-overview.md` — how Batshit works end to end; the best "what is Batshit really" page.
- `reference-glossary.md` — canonical definitions for Batshit terms.

**Installation and updates**
- `installation-choose-mac-app-or-docker.md` — comparison of the supported install paths.
- `installation-install-mac-app.md` — Mac app install walkthrough.
- `installation-install-docker.md` — Docker/Compose install walkthrough.
- `installation-install-pinokio.md` — Pinokio install, supported platform limits and existing voice-engine connections.
- `installation-docker-runtime-and-add-ons.md` — Docker sidecars, profiles, add-ons, host operator.
- `installation-first-run.md` — first-run setup and onboarding.
- `installation-updating-batshit.md` — update notices and how updates work per lane.

- `reference-release-notes.md` — current upgrade warnings and release behavior.

**Providers and models**
- `providers-overview.md` — provider landscape: gateway, direct, OpenRouter.
- `providers-api-keys-and-models.md` — adding keys, choosing models, defaults.
- `providers-model-catalog.md` — Model Catalog and Model Presets.

- `providers-claude-plan.md` — Claude plan setup, controls and usage.

**Security**
- `security-overview.md` — trust model, boundaries, what to be careful with.

- `fabric-app-actions.md` — scoped App Actions access, review and outcomes.

**Agents**
- `primary-agents-overview.md` — Primary Agents and their model connections.
- `primary-agents-agent-dms-and-wake-ups.md` — Agent DMs between primary agents, wake-ups (chats Batshit starts on its own), the inbox drawer, and wake-up webhooks.
- `primary-agents-connect-n8n.md` — connecting n8n workflow tools and wake-up workflows.
- `subagents-overview.md` — Subagents, Workers and when delegation helps.
- `groups-overview.md` — Group Chat: multi-agent sessions with a single-speaker queue.

**Chat workspace**
- `chat-overview.md` — the chat surface and its parts.
- `chat-sessions-sidebar.md` — sessions, folders, locking.
- `chat-execution-viewer.md` — inspecting what was actually sent to the model, tokens, snapshots.
- `chat-compact-and-trim.md` — Auto Compact and Manual Trim for tight context.
- `chat-artifact-zones.md` — where published artifacts live in the workspace.
- `chat-memory-and-infinite-sessions.md` — Agent Memory and Infinite Sessions.

**Zips, Clips, and token efficiency**
- `tools-zips.md` — Zips from the user side: behavior, buffer, threshold.
- `chat-zip-manager.md` — the Zip Manager surface.
- `clips-overview.md` — Clips: reusable uploads that persist across messages.
- `chat-clips-manager.md` — the Clips Manager surface.
- `architecture-zips-and-clips.md` — how compression works under the hood.
- `architecture-context-caching-tokens.md` — context assembly, caching, and token optimization.

**Tools and capabilities**
- `tools-overview.md` — Tools, MCPs, CLI Tools, and Skills in one map.
- `architecture-tools-without-bloat.md` — Dynamic Tool Search and why prompts stay small.
- `fabric-overview.md` — Fabric: the agent-operated control plane for Batshit itself.

**Skills and prompts**
- `skills-overview.md` — Skills, skill sources, enablement/trust, and Prompts.
- `user-overview.md` — User settings including the global custom prompt.

**Portable Skills** (Batshit skills installed into outside coding agents)
- `skills-portable-skills.md` — concept, tokens, scopes, install flow.
- `reference-portable-skills.md` — the public bundle downloads.
- `skills-portable-skills-artifact-creator.md`, `skills-portable-skills-cli-tool-creator.md`, `skills-portable-skills-goon-scene-creator.md`, `skills-portable-skills-skill-creator.md`, `skills-portable-skills-voice-engine-installer.md` — per-bundle pages.
- `skills-portable-skills-batshit-guide.md` — the outside-agent Batshit Guide bundle.

**Artifacts**
- `artifacts-overview.md` — persistent mini-apps: building, publishing, zones.
- `artifacts-agent-use.md` — letting agents run published artifacts as tools.
- `artifacts-pinokio.md` — apps installed in Pinokio as artifacts, and Start with Pinokio.
- `architecture-artifacts-and-fabric.md` — how artifacts and Fabric fit together.

**Projects and files**
- `projects-overview.md` — project folders, the file tree, @-mentions, uploads.

**Goons (3D avatars)**
- `goons-overview.md` — what Goons are and the Goon Dock.
- `goons-setup-and-packages.md` — Goon setup and advanced packages.

**Voice**
- `voice-overview.md` — voice chat at a glance.
- `voice-voice-settings.md` — TTS/STT engines, per-agent voices, Engine Manager.
- `voice-voice-clones.md` — voice clones and Voice Studio.

**Local AI**
- `local-ai-overview.md` — connecting the eight local AI programs: Ollama, Docker Model Runner, LM Studio, llama.cpp, vLLM, SGLang, oMLX, KoboldCpp.
- `local-ai-model-settings.md` — what Batshit sends, why blank means blank, per-program settings, the Ollama context trap, model formats.
- `local-ai-speed-and-caching.md` — local prompt caching, what resets it, and reading the speed numbers.
- `local-ai-sglang-and-omlx.md` — setting up SGLang and oMLX, local API keys, the shared port 8000.

**Judge Juice and memory**
- `judge-juice-overview.md` — optional TypeSafe judgments, setup, feature switches, privacy, and evidence.

**n8n resources**
- `reference-templates.md` — template downloads.

**Admin**
- `admin-overview.md` — the Admin area: core prompts, diagnostics, update settings.
- `admin-backup-and-restore.md` — full backup/restore of Batshit data.

**Architecture deep reads** (for "how does this really work" questions)
- `architecture-agents-and-runtime-paths.md` — how agents reach their models and run tools.
- `architecture-streaming-and-recovery.md` — streaming, failed sends, recovery behavior.
- `architecture-local-first-boundaries.md` — what stays local and where the boundaries sit.

**Reference**
- `reference-ports-and-urls.md` — canonical ports/URLs per install lane.
- `reference-env-vars.md` — environment variables.
- `reference-provider-prompt-caching.md` — provider prompt caching support and behavior.
- `user-templates-batshit-anime-hair-studio.md` — official Anime Hair Studio starter template.

**Troubleshooting**
- `troubleshooting-agents-and-tools.md` — agents misbehaving, tools not appearing.
- `troubleshooting-n8n.md` — n8n connection and workflow issues.
- `troubleshooting-voice-local-ai.md` — voice engines and Local AI runtimes.
- `troubleshooting-docker.md` — Docker lane issues.
- `troubleshooting-backup-restore.md` — backup/restore problems.
- `troubleshooting-bug-reports-and-diagnostics.md` — collecting a safe diagnostics zip for a bug report.

## App Actions and current plugin setup

Read `fabric-app-actions.md` for supported Settings changes, exact access/review steps, MCP setup limits and uncertain-outcome recovery. Read `skills-overview.md` and `skills-portable-skills.md` for the complete eight-skill plugin download. Reading this Guide stays token-free. For an explicitly requested operation, route to the separate enabled **App Actions** skill and its native or outside guide; never infer permission from this informational Guide or a downloaded package. New Goon App Actions, automatic runtime repair and extra provider account catalogs are outside that workflow.
