# Skills & Prompts

Skills and Prompts are the two ways you shape *how* an agent works rather than *which model* it runs. Skills are reusable, loadable capabilities an agent can pull in when a request calls for them. Prompts are the standing instructions — system prompts and custom prompts — that define an agent's behavior on every message. This page teaches both concepts from zero and points to the detail pages.

Open **Settings → Plugins & shit**. Its Plugins tab manages complete skill packages; Skills, Skill Sources, Prompts and Portable Skills provide the related controls.

## What a Skill is

A Skill is a reusable bundle of instructions — and often reference files — that teaches an agent how to do a heavier, repeatable workflow. Think of it as a saved playbook the agent can open when it's the right tool for the job: a multi-step process, a domain it should follow carefully, or a task with its own rules and examples.

Skills are invoked in a slash-command style (for example, a `Skill Creator` skill is `/skill-creator`). But here's the part that matters most and is easy to miss:

**You do not have to type the slash command yourself.** When you enable a Skill for an agent, you're granting that agent permission to load and use the Skill on its own when your request clearly matches what the Skill is for. You can still invoke a Skill explicitly, but enabling it is the standing green light — the agent picks it up when it fits.

That's why Skill enablement is a trust decision. An enabled Skill is one the agent may reach for without asking first, so enable the Skills you trust and leave the rest off.

Skills are session-free: they don't carry conversation state between uses. Each time a Skill runs, it runs fresh from its saved instructions.

## The Batshit plugin

Batshit ships one protected **Batshit** plugin containing eight skills:

- **Batshit Guide** (`/batshit:batshit-guide`) — official product help; reading it needs no token.
- **App Actions** (`/batshit:app-actions`) — supported app operations under your explicit access and approval policies. See [App Actions](../fabric/app-actions.md).
- **Goon Guide** (`/batshit:goon-guide`) — supported Goon setup and use; informational only.
- **Artifact Creator** (`/batshit:artifact-creator`) — build panels and Artifact tools.
- **CLI Tool Creator** (`/batshit:cli-tool-creator`) — create saved CLI Tools.
- **Goon Scene Creator** (`/batshit:goon-scene-creator`) — plan rooms, textures, skyboxes, props and animated panorama backgrounds.
- **Skill Creator** (`/batshit:skill-creator`) — create reusable Skills and Prompts.
- **TTS/STT Engine Installer** (`/batshit:voice-engine-installer`) — install and register voice engines.

The package has one access setting for all its skills. Enable it for all agents in **Plugins**, or choose its access for one agent in **Agent Settings → Access**. On upgrade, earlier active built-in skill access is combined into package access: everyone if any active skill was global, otherwise the named agents from those active skills. An all-off setup stays off. Review the package access if you want to narrow it. A Subagent follows its own access; installing a package grants no tools or token permissions.

Use the namespaced slash command shown in Settings. Bare aliases work when unambiguous; Batshit asks you to choose when another package uses the same name. An agent can load a skill only when the package is enabled for it.

### Import and recover a plugin

In **Plugins → Import a Plugin**, choose a trusted skills-only Agent Plugins ZIP, no larger than 32 MB, and import it. Claude-compatible plugin metadata can be included. Packages containing executable plugin components are refused. Imported packages start off; review them before enabling access.

If import is incomplete, the package stays off. Remove that incomplete import before trying again. If removal is incomplete, finish removal to clear its remaining files. Refresh saved state after an unconfirmed result; do not keep importing the same package because a response was lost.

### Use the plugin outside Batshit

Open **Plugins → Batshit → Download Plugin**. This downloads the complete current package, including its reference files and supported outside-agent instructions. Install the ZIP through your assistant’s supported plugin installer, or give it the extracted skill folder with its references. See [Outside-agent setup](portable-skills.md).

The Goon Scene Creator includes ComfyUI workflow definitions, not model weights.

## Skill sources

Beyond the built-ins, you can add your own Skills by pointing Batshit at a folder of Skill bundles. Settings → Plugins & shit → Skill Sources manages those folders: you give a source a label and a path, set its trust and access, then Batshit scans it and lists the Skills it found under your Skills. This is how you bring a library of your own playbooks into Batshit.

Only add Skill sources you trust. A Skill is instructions an agent will follow, so treat an untrusted Skill the same way you'd treat untrusted code.

## What Prompts are

Prompts are the instructions that shape an agent's behavior on every message, not just when a workflow comes up. In Batshit there are two layers most users touch:

- **System prompts** — the core behavioral instructions for an agent. Each agent has its own, and Batshit also supplies its base agent instructions.
- **A global custom prompt** — your own standing instructions that apply across agents when enabled (for example, a tone or formatting preference you want everywhere). This one lives in your User settings; see [the User area](../user/overview.md).

The Prompts tab in Settings → Plugins & shit is where you create and edit saved prompt templates. Core Batshit system prompts — the foundational prompts that keep tools, Skills, zips, and voice working — are managed separately in Settings → Admin, because editing them can change how the whole product behaves; see [the Admin area](../admin/overview.md).

## Portable Skills

Use the complete Batshit plugin with an outside assistant such as Claude Code, Codex or another supported local agent. Batshit Guide and Goon Guide are informational and need no token. Operational skills use a scoped Portable Skill Token; App Actions additionally needs its explicitly saved subject, effect and expiry grant.

Keep tokens out of the downloaded package. [Outside-agent setup](portable-skills.md) covers download, installation, private env files and permissions. The old separate per-skill downloads are retained only as older-version archives.

## In this section

- [Portable Skills](portable-skills.md) — carry Batshit Skills into an outside coding agent with a scoped token.

## Related

- [Tools](../tools/overview.md) — Skills sit alongside tools, MCPs, and CLI Tools as ways agents get work done.
- [Primary Agents](../primary-agents/overview.md) — Skills are enabled per agent in Settings → Agents → Access.
- [User](../user/overview.md) — your global custom prompt.
- [Admin](../admin/overview.md) — core system prompt editing.
