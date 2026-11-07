# Use the Batshit plugin outside the app

The complete **Batshit** plugin carries eight skills into an outside coding agent. Download it from **Settings → Plugins & shit → Plugins → Batshit → Download Plugin**. It includes the current official help and the native/outside instructions each skill needs.

They are useful when you want your own agent, such as Claude Code, Codex, or another local coding assistant, to do setup work against your local Batshit instance without giving it Batshit's internal service token or your Batshit password.

## What Portable Skills are

A Portable Skill is a folder with:

- `SKILL.md`, the instructions your outside agent reads.
- `references/`, the same Batshit-owned domain guidance used by the matching in-app skill where that guidance can be shared safely.
- optional `assets/`, such as non-secret workflow templates owned by the matching in-app skill.

Portable Skills come in two kinds:

- **Operational** bundles perform real Batshit work from outside (install a voice engine, build an artifact, save a CLI tool or skill, plan a Goon scene). They authenticate with a scoped Portable Skill Token.
- **Informational** bundles only teach the outside agent. Batshit Guide and Goon Guide are informational and need **no token at all**. App Actions is a separate operational skill with explicit access.

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
2. Go to Settings → Plugins & shit → Portable Skills.
3. Click **Create Portable Skill Token**.
4. Pick only the scopes the outside agent needs.
5. Copy the token when Batshit shows it. It is shown once.

Scopes match the current Portable Skill families:

| Scope | Use it for |
| --- | --- |
| App Actions | Supported Settings operations, with a separately saved scope and expiry grant |
| Voice Engines | Portable Voice Engine Installer |
| Artifacts | Portable Artifact Creator |
| CLI Tools | Portable CLI Tool Creator |
| Skills | Portable Skill Creator |
| Goon Scenes | Portable Goon Scene Creator |

Batshit Guide and Goon Guide are informational and have no scope. Skip token creation if you only want help. Installing the plugin does not enable operational scopes.

A token can have more than one scope. For the simplest setup, create one token with the scopes you plan to use and store it once in `portable-skills.env`. Use separate tokens only when you want a tighter boundary for a specific job. You can rotate or revoke tokens from the same Settings page.

Never give an outside agent `BATSHIT_TOKEN`. Portable Skill Tokens are narrower, revocable, and stored in Batshit as hashes.

A Portable Skill Token only works on the two control endpoints above, and only for the controls its scopes include. It is not a general login for your Batshit app: every other app endpoint turns it away, even one that would let you do the same thing while signed in. For example, a token with the CLI Tools scope can save and test a CLI tool through `POST /api/controls/use`, but it cannot run your saved CLI tools directly. A wrong, revoked, or out-of-scope token is simply refused. Batshit never treats a refused token as your signed-in browser session.

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

On Mac/native Batshit, Settings → Plugins & shit → Portable Skills creates the shared placeholder file when possible. Batshit never writes the real token automatically because it stores only the token hash after creation. After token creation or rotation, copy the `.env` snippet Batshit shows and paste it deliberately into your private file.

For Docker Batshit, save the file on the host where your outside agent runs. The app container may not be able to write your host home folder.

Do not save real tokens inside the downloaded Portable Skill bundle. Bundles should stay safe to re-download, share, delete, and replace.

## Download and install the complete plugin

1. Open **Settings → Plugins & shit → Plugins**.
2. Find **Batshit** and choose **Download Plugin**.
3. Give the downloaded ZIP to your outside assistant's supported plugin installer. Keep the entire package and reference files together.
4. If your assistant accepts individual skills rather than plugins, use the desired folder inside the package's `skills/` directory with its complete `references/` and `assets/`, where present. Follow that assistant's supported local skill installation instructions.

For an assistant without skill discovery, point it at the extracted skill's `SKILL.md` and ask it to follow that file. The skill chooses its outside instructions. A package install alone grants no Batshit permissions.

Do not use the older separate `/portable-skills/*.zip` downloads to set up the current release. Those are [older-version archives](../reference/portable-skills.md), kept for people maintaining an older installation. Their bundled help may describe removed agent types.

## Use with a generic agent

If your agent does not have automatic skill discovery, point it at the extracted `SKILL.md` and tell it to follow the instructions.

Give it:

- the Batshit base URL, usually `http://127.0.0.1:5620`;
- the Portable Skill Token or private env file path, usually `~/.batshit/portable-skills/portable-skills.env`;
- the job you want done.

An operational skill checks `/api/health`, proves its token scope and reports an unavailable instance or missing scope. Informational help needs neither a token nor that handshake.

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

## Skills in the current plugin

- [Batshit Guide](portable-skills-batshit-guide.md) — informational, no token needed
- Goon Guide — informational, no token needed
- [App Actions](../fabric/app-actions.md) — explicit scoped access and one-operation review
- [Voice Engine Installer](portable-skills-voice-engine-installer.md)
- [Artifact Creator](portable-skills-artifact-creator.md)
- [CLI Tool Creator](portable-skills-cli-tool-creator.md)
- [Skill Creator](portable-skills-skill-creator.md)
- [Goon Scene Creator](portable-skills-goon-scene-creator.md)
