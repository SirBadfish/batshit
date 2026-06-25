# Skills & Prompts

Skills and Prompts are the two ways you shape *how* an agent works rather than *which model* it runs. Skills are reusable, loadable capabilities an agent can pull in when a request calls for them. Prompts are the standing instructions — system prompts and custom prompts — that define an agent's behavior on every message. This page teaches both concepts from zero and points to the detail pages.

Settings → Skills & Prompts is where all of this lives, organized into Skills, Skill Sources, and Prompts.

## What a Skill is

A Skill is a reusable bundle of instructions — and often reference files — that teaches an agent how to do a heavier, repeatable workflow. Think of it as a saved playbook the agent can open when it's the right tool for the job: a multi-step process, a domain it should follow carefully, or a task with its own rules and examples.

Skills are invoked in a slash-command style (for example, a `Skill Creator` skill is `/skill-creator`). But here's the part that matters most and is easy to miss:

**You do not have to type the slash command yourself.** When you enable a Skill for an agent, you're granting that agent permission to load and use the Skill on its own when your request clearly matches what the Skill is for. You can still invoke a Skill explicitly, but enabling it is the standing green light — the agent picks it up when it fits.

That's why Skill enablement is a trust decision. An enabled Skill is one the agent may reach for without asking first, so enable the Skills you trust and leave the rest off.

Skills are session-free: they don't carry conversation state between uses. Each time a Skill runs, it runs fresh from its saved instructions.

## Built-in Skills

Batshit ships with a few system Skills you can enable right away:

- **Artifact Creator** (`/artifact-creator`) — helps build Artifacts.
- **CLI Tool Creator** (`/cli-tool-creator`) — helps set up saved CLI Tools.
- **TTS/STT Engine Installer** (`/voice-engine-installer`) — helps install and connect local voice engines.

These are first-party and keep their core identity read-only, but you still control their status, trust, and which agents may use them.

## Skill sources

Beyond the built-ins, you can add your own Skills by pointing Batshit at a folder of Skill bundles. Settings → Skills & Prompts → Skill Sources manages those folders: you give a source a label and a path, set its trust and access, then Batshit scans it and lists the Skills it found under your Skills. This is how you bring a library of your own playbooks into Batshit.

Only add Skill sources you trust. A Skill is instructions an agent will follow, so treat an untrusted Skill the same way you'd treat untrusted code.

## What Prompts are

Prompts are the instructions that shape an agent's behavior on every message, not just when a workflow comes up. In Batshit there are two layers most users touch:

- **System prompts** — the core behavioral instructions for an agent. Each agent has its own, and Batshit also compiles in a base prompt for the agent's type.
- **A global custom prompt** — your own standing instructions that apply across agents when enabled (for example, a tone or formatting preference you want everywhere). This one lives in your User settings; see [the User area](../user/overview.md).

The Prompts tab in Settings → Skills & Prompts is where you create and edit saved prompt templates. Core Batshit system prompts — the foundational prompts that keep tools, Skills, zips, and voice working — are managed separately in Settings → Admin, because editing them can change how the whole product behaves; see [the Admin area](../admin/overview.md).

## Portable Skills

Portable Skills are a special kind of Skill that runs **outside** Batshit. Instead of an in-app agent loading the Skill, you install the Skill bundle into your own coding agent — Claude Code, Codex, or another local assistant — and it operates your local Batshit instance through a narrow, scoped Portable Skill Token. No Batshit password, no internal service token.

They're useful when you'd rather have an outside agent you already pay for do longer local setup work, like installing a local voice engine or building a CLI Tool, while still following Batshit's own guidance.

Full details — tokens, scopes, install paths, and the current bundles — are in [Portable Skills](portable-skills.md).

## In this section

- [Portable Skills](portable-skills.md) — carry Batshit Skills into an outside coding agent with a scoped token.

## Related

- [Tools](../tools/overview.md) — Skills sit alongside tools, MCPs, and CLI Tools as ways agents get work done.
- [Primary Agents](../primary-agents/overview.md) — Skills are enabled per agent in Agent Settings → Access.
- [User](../user/overview.md) — your global custom prompt.
- [Admin](../admin/overview.md) — core system prompt editing.
