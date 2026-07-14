# Portable Skill downloads

This page lists the Portable Skill bundles published by the docs site under `/portable-skills/`.

Portable Skill bundles are public and secret-free. Your private token belongs in Settings -> Skills & Prompts -> Portable Skills and, if you choose, a local file under `~/.batshit/portable-skills/`.

## Current bundles

| Portable Skill | Token scope | Zip | Browsable entrypoint |
| --- | --- | --- | --- |
| Voice Engine Installer | Voice Engines | [voice-engine-installer.zip](/portable-skills/voice-engine-installer.zip) | [SKILL.md](/portable-skills/voice-engine-installer/SKILL.md) |
| Artifact Creator | Artifacts | [artifact-creator.zip](/portable-skills/artifact-creator.zip) | [SKILL.md](/portable-skills/artifact-creator/SKILL.md) |
| CLI Tool Creator | CLI Tools | [cli-tool-creator.zip](/portable-skills/cli-tool-creator.zip) | [SKILL.md](/portable-skills/cli-tool-creator/SKILL.md) |
| Skill Creator | Skills | [skill-creator.zip](/portable-skills/skill-creator.zip) | [SKILL.md](/portable-skills/skill-creator/SKILL.md) |
| Goon Scene Creator | Goon Scenes | [goon-scene-creator.zip](/portable-skills/goon-scene-creator.zip) | [SKILL.md](/portable-skills/goon-scene-creator/SKILL.md) |

## Install guide

Start with [Portable Skills](../skills/portable-skills.md) for token setup, private env-file guidance, and install paths for Claude Code, Codex, and generic outside agents.

## Copy-ready install prompts

Paste one of these into the outside agent that should install the skill:

```txt
Install the Batshit Portable Voice Engine Installer skill from https://docs.batshit.ai/portable-skills/voice-engine-installer.zip. Use credentials from ~/.batshit/portable-skills/portable-skills.env.
```

```txt
Install the Batshit Portable Artifact Creator skill from https://docs.batshit.ai/portable-skills/artifact-creator.zip. Use credentials from ~/.batshit/portable-skills/portable-skills.env.
```

```txt
Install the Batshit Portable CLI Tool Creator skill from https://docs.batshit.ai/portable-skills/cli-tool-creator.zip. Use credentials from ~/.batshit/portable-skills/portable-skills.env.
```

```txt
Install the Batshit Portable Skill Creator skill from https://docs.batshit.ai/portable-skills/skill-creator.zip. Use credentials from ~/.batshit/portable-skills/portable-skills.env.
```

```txt
Install the Batshit Portable Goon Scene Creator skill from https://docs.batshit.ai/portable-skills/goon-scene-creator.zip. Use credentials from ~/.batshit/portable-skills/portable-skills.env.
```

## Per-skill guides

- [Portable Voice Engine Installer](../skills/portable-skills-voice-engine-installer.md)
- [Portable Artifact Creator](../skills/portable-skills-artifact-creator.md)
- [Portable CLI Tool Creator](../skills/portable-skills-cli-tool-creator.md)
- [Portable Skill Creator](../skills/portable-skills-skill-creator.md)
- [Portable Goon Scene Creator](../skills/portable-skills-goon-scene-creator.md)
