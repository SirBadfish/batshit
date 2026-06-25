# Batshit Portable Skills

Batshit Portable Skills are the same Batshit-owned system-skill workflows made runnable from an outside coding agent.

Each portable bundle is a plain folder:

- `SKILL.md` — agent-agnostic instructions for the outside-agent lane
- `references/` — shared domain knowledge copied from the in-app system skill source

Portable skills operate on a local Batshit instance only through HTTP:

- default base URL: `http://127.0.0.1:5620`
- health probe: `GET /api/health`
- operation endpoint: `POST /api/controls/use`
- auth header: `x-batshit-portable-token`

Do not paste `BATSHIT_TOKEN`, user passwords, or n8n callback tokens into outside agents. Use a scoped Portable Skill Token from Settings -> Skills & Prompts -> Portable Skills.

## Bundles

- `voice-engine-installer/` — portable variant of `/voice-engine-installer`
- `artifact-creator/` — portable variant of `/artifact-creator`
- `cli-tool-creator/` — portable variant of `/cli-tool-creator`
- `skill-creator/` — portable variant of `/skill-creator`

Each bundle needs a Portable Skill Token with the matching scope. A token may include more than one scope; store that token once in `~/.batshit/portable-skills/portable-skills.env` when you want the same token to power multiple Portable Skills. Use per-skill env files only when you deliberately want narrower tokens.
