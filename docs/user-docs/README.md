# Batshit UserDocs

These are the launch-facing UserDocs source for Batshit. They should be useful, current, and honest before they're beautiful.

Batshit is planned for public release as open source under **AGPL-3.0-only**. The Batshit name, logo, mascot, and visual identity are protected separately by the project's trademark policy.

User-created chats, agents, prompts, workflows, artifacts, uploaded files, project files, generated content, and local data remain the user's content. Batshit integrates with n8n, which is separately licensed by n8n.

## Start here

Use [the User Docs index](index.md) as the launch-facing navigation surface. Pages are grouped by subject/feature (install-first), so the index links installation, providers, security, the feature subjects, troubleshooting pages, and reference material — with concepts taught inline per subject.

Current reference docs:

- [Ports and URLs](reference/ports-and-urls.md) — local ports, Docker service URLs, health checks, and caller-relative URL rules.
- [Environment variables](reference/env-vars.md) — practical env var map for Mac app, advanced source-checkout repair, and Docker installs.
- [Templates](reference/templates.md) — n8n workflow template inventory and setup notes.
- [Portable Skill downloads](reference/portable-skills.md) — public, secret-free Portable Skill bundles and zip downloads.
- [LLM map](reference/llms.txt) — concise machine-readable map for LLMs and docs tooling.

Mac app and Docker are peer setup paths. The Mac app is the normal Mac local path with Runtime Doctor, host-local runtime access, and Apple Container as the default command sandbox on supported Macs. Docker is the more contained Compose path with clearer package boundaries, explicit sidecars, and the host-operator path for Docker Sandbox/add-on control. Manual source-checkout setup is advanced repair/development material, not the normal public install path.

## Current launch truth

- Public launch posture: alpha.
- License wording: AGPL-3.0-only.
- Mac app browser companion URL: `http://127.0.0.1:5620`.
- Docker browser-facing Batshit URL: `http://localhost:5620`.
- Source-checkout dev browser-facing Batshit URL: `http://localhost:5621`.
- Browser-facing batshit-server URL: `http://localhost:5600`.
- Mac app local data: `~/Library/Application Support/Batshit`; logs: `~/Library/Logs/Batshit`; cache: `~/Library/Caches/Batshit`.
- Docker internal app URL: `http://app:3000`.
- n8n default URL: `http://localhost:5678` from the browser, `http://n8n:5678` from the optional Docker n8n profile network.
- Primary Agent names: `API` and `CLI`.
- Subagent names: `API Subagents`, `CLI Subagents`, and `n8n Workflow Subagents`.
- Portable Skills are downloaded from the docs site and use scoped Portable Skill Tokens from Settings -> Skills & Prompts -> Portable Skills, never `BATSHIT_TOKEN`.

## Source rule

`docs/user-docs/` is the only canonical public UserDocs source tree. The online docs site, raw Markdown files, LLM text bundles, and public template downloads are generated from this folder.

The official n8n templates under `docs/user-docs/user-templates/batshit-official-n8n-workflow-templates/` are the current public-safe workflow templates. Don't keep old guide sets, raw experiments, private setup notes, or unvalidated template experiments in this tree.

## Writing rules

- Use `Batshit` in prose, never old product names. All-caps `BATSHIT` appears only inside literal env var names.
- **Headings are sentence case** — capitalize only the first word, product terms (Primary Agent, Clip, Zip, Tool Grid, Goon, Voice Mode), and acronyms (API, CLI, n8n, TTS, STT, MCP, URL). Not "What Stays The Same" — "What stays the same."
- **Teach novel concepts from zero.** Batshit invented a lot the world hasn't seen — Zips, Clips, the Tool Grid, DCM, Schema Hints, Group Chat's single-speaker queue, the Execution Viewer, Goons. For those, lead with *why it exists / what problem it solves* before *how to use it*.
- **Keep prose self-sufficient.** Screenshots reinforce; they never carry meaning the text lacks. A stale screenshot must never break comprehension, and AI/screen-reader users must get the full story from words + alt text.
- **Profanity is allowed where it fits the brand** (the product is named Batshit). Use it naturally — "this part is easy to fuck up," "not the same shit you're used to" — never forced, never trying to hit a quota.
- Don't use retired numbered or n8n-primary terminology. Use `API` and `CLI` for Primary Agents, and `API Subagents` / `CLI Subagents` / `n8n Workflow Subagents` for Subagents.
- Never publish real tokens, API keys, local secrets, private local paths, or raw logs.
- Don't tell public users to run private development launchers as install steps.
- Don't present manual source-checkout setup as the normal public Mac path while the Mac app path is supported.
- Explain Docker URLs by caller: browser, app container, batshit-server, n8n, host service, or sidecar. The canonical caller table lives in `reference/ports-and-urls.md`; link to it rather than re-tabling it on every page.
- Make failures explicit. Don't hide missing setup behind "it should just work" language.
- Screenshots and images live in `docs/user-docs/images/` and publish to the site at `/docs-images/...`. Reference them with root-absolute paths (for example `![Zip Manager panel](/docs-images/chat/zip-manager.png)`), always with descriptive alt text, and keep the prose self-sufficient so a stale or missing image never breaks comprehension.

## Release polish

- Screenshots of Batshit-original features and Settings panels (in progress — captured from a test instance, prioritizing the new-to-the-world concepts).
- Final click-by-click product tours.
- Final Mac app P6 product-surface screenshots and release-candidate notes.
- Final public website/docs navigation.
