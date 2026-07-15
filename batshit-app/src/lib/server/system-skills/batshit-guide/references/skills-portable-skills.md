# Portable Skills

Portable Skills are Batshit system skills you can carry into an outside coding agent.

They are useful when you want your own agent, such as Claude Code, Codex, or another local coding assistant, to do setup work against your local Batshit instance without giving it Batshit's internal service token or your Batshit password.

## What Portable Skills are

A Portable Skill is a folder with:

- `SKILL.md`, the instructions your outside agent reads.
- `references/`, the same Batshit-owned domain guidance used by the matching in-app skill where that guidance can be shared safely.
- optional `assets/`, such as non-secret workflow templates owned by the matching in-app skill.

Portable Skills come in two kinds:

- **Operational** bundles perform real Batshit work from outside (install a voice engine, build an artifact, save a CLI tool or skill, plan a Goon scene). They authenticate with a scoped Portable Skill Token.
- **Informational** bundles only teach the outside agent. The Portable Batshit Guide is the first of these: it carries the official Batshit docs as references and needs **no token at all**.

Operational Portable Skills call Batshit through the local app API:

- Health check: `GET /api/health`
- Operation endpoint: `POST /api/controls/use`
- Optional discovery endpoint: `POST /api/controls/find`
- Auth header: `x-batshit-portable-token`

They do not write Redis directly, edit Batshit source, copy browser cookies, script your login form, or use `BATSHIT_TOKEN`. Informational bundles use none of the above — at most the public health check.

## When to use one

Use a Portable Skill when:

- you already pay for or prefer an outside coding agent;
- setup is long enough that you want that agent to do the work;
- the work happens on your own machine, such as local voice engines or CLI tools;
- you want the same Batshit workflow guidance outside the app.

Use the in-app skill when:

- you are already chatting inside Batshit;
- the job is small;
- you want Batshit to keep all instructions and tool calls inside the normal chat/runtime path.

Portable Skills complement in-app skills. They are not a replacement for Batshit agents.

## Create a Portable Skill Token

1. Open Batshit.
2. Go to Settings -> Skills & Prompts -> Portable Skills.
3. Click **Create Portable Skill Token**.
4. Pick only the scopes the outside agent needs.
5. Copy the token when Batshit shows it. It is shown once.

Scopes match the current Portable Skill families:

| Scope | Use it for |
| --- | --- |
| Voice Engines | Portable Voice Engine Installer |
| Artifacts | Portable Artifact Creator |
| CLI Tools | Portable CLI Tool Creator |
| Skills | Portable Skill Creator |
| Goon Scenes | Portable Goon Scene Creator |

The Portable Batshit Guide is informational and has no scope — skip token creation entirely if that is the only bundle you want.

A token can have more than one scope. For the simplest setup, create one token with the scopes you plan to use and store it once in `portable-skills.env`. Use separate tokens only when you want a tighter boundary for a specific job. You can rotate or revoke tokens from the same Settings page.

Never give an outside agent `BATSHIT_TOKEN`. Portable Skill Tokens are narrower, revocable, and stored in Batshit as hashes.

## Private env file option

If you do not want to paste the token repeatedly, use a private env file on your own machine:

```txt
BATSHIT_BASE_URL=http://127.0.0.1:5620
BATSHIT_PORTABLE_TOKEN=paste-your-portable-skill-token-here
```

Recommended file location:

```txt
~/.batshit/portable-skills/portable-skills.env
```

Use this shared file when one token should work for more than one Portable Skill. If you want a narrower token for one skill, you may instead create a skill-specific override file such as:

```txt
~/.batshit/portable-skills/artifact-creator.env
```

On Mac/native Batshit, Settings -> Skills & Prompts -> Portable Skills creates the shared placeholder file when possible. Batshit never writes the real token automatically because it stores only the token hash after creation. After token creation or rotation, copy the `.env` snippet Batshit shows and paste it deliberately into your private file.

For Docker Batshit, save the file on the host where your outside agent runs. The app container may not be able to write your host home folder.

Do not save real tokens inside the downloaded Portable Skill bundle. Bundles should stay safe to re-download, share, delete, and replace.

## Download a bundle

Portable Skill bundles are published by the docs site under `/portable-skills/`.

See [Portable Skill downloads](../reference/portable-skills.md) for the current bundle list.

Download the zip for the skill you need, then extract it so your outside agent can read the folder.

The Portable Skills tab also shows one install prompt per skill. Copy that line into your outside agent when you want it to install a bundle for you.

The prompt format is:

```txt
Install the Batshit Portable <skill name> skill from <bundle zip URL>. Use credentials from ~/.batshit/portable-skills/portable-skills.env.
```

Informational bundles use a token-free variant instead:

```txt
Install the Batshit Portable Batshit Guide skill from https://docs.batshit.ai/portable-skills/batshit-guide.zip. No token or env file is needed; it is informational only.
```

Example:

```txt
Install the Batshit Portable Voice Engine Installer skill from https://docs.batshit.ai/portable-skills/voice-engine-installer.zip. Use credentials from ~/.batshit/portable-skills/portable-skills.env.
```

## Install into Claude Code

Claude Code discovers skills from skill folders. A normal user-level install is:

```txt
~/.claude/skills/<skill-id>/SKILL.md
```

Example:

```txt
~/.claude/skills/voice-engine-installer/SKILL.md
```

Put the whole extracted bundle folder there, including `references/`.

## Install into Codex

For Codex builds that support local skills, install the folder in your Codex skills directory. The common local path is:

```txt
~/.codex/skills/<skill-id>/SKILL.md
```

Example:

```txt
~/.codex/skills/artifact-creator/SKILL.md
```

Put the whole extracted bundle folder there, including `references/`.

## Use with a generic agent

If your agent does not have automatic skill discovery, point it at the extracted `SKILL.md` and tell it to follow the instructions.

Give it:

- the Batshit base URL, usually `http://127.0.0.1:5620`;
- the Portable Skill Token or private env file path, usually `~/.batshit/portable-skills/portable-skills.env`;
- the job you want done.

The skill should first check `/api/health`, prove the token, and stop loudly if Batshit is not reachable or the token scope is wrong.

## Base URL and Docker notes

Default Mac app URL:

```txt
http://127.0.0.1:5620
```

Docker browser URL is usually:

```txt
http://localhost:5620
```

Docker has caller-relative URLs. A URL that works in your browser may not be the URL the app container uses to reach a host service. For local voice engines, CLI tools, webhooks, ComfyUI, Gradio, or other sidecars, read [Ports and URLs](../reference/ports-and-urls.md) and use the URL that matches the caller.

## Security habits

- Give the token only the scope needed for the current job.
- Revoke tokens after one-off setup work when you no longer need them.
- Never put real tokens in downloaded bundles, Git repos, screenshots, or support logs.
- Do not install untrusted Portable Skills.
- Read the `SKILL.md` before running high-risk local setup.

## Current Portable Skills

- [Batshit Guide](portable-skills-batshit-guide.md) — informational, no token needed
- [Voice Engine Installer](portable-skills-voice-engine-installer.md)
- [Artifact Creator](portable-skills-artifact-creator.md)
- [CLI Tool Creator](portable-skills-cli-tool-creator.md)
- [Skill Creator](portable-skills-skill-creator.md)
- [Goon Scene Creator](portable-skills-goon-scene-creator.md)
