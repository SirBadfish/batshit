# Portable Skill Authoring Conventions

Portable skills must stay agent-agnostic.

## Format

- One folder per skill.
- `SKILL.md` is plain Markdown with minimal YAML frontmatter.
- Required frontmatter: `name`, `description`.
- Optional metadata must be safe for agents to ignore.
- References are ordinary Markdown files under `references/`.
- No bundled scripts in v1 portable bundles.

## Transport

Portable skills call Batshit over HTTP:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/use" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{"controlId":"sys.runtime_addon.status","input":{"addonId":"voice-engines"}}'
```

Every portable skill must:

1. Resolve the Batshit base URL, defaulting to `http://127.0.0.1:5620`.
2. Require `GET /api/health` to return `ok: true`.
3. Prove the Portable Skill Token with a low-risk in-family control before mutating anything.
4. Stop loudly if Batshit is unreachable, the token is missing, or the token lacks the required family scope.

## Private Token Files

Downloaded bundles must stay secret-free. If a user wants a local env file, use:

```txt
~/.batshit/portable-skills/portable-skills.env
```

Expected contents:

```txt
BATSHIT_BASE_URL=http://127.0.0.1:5620
BATSHIT_PORTABLE_TOKEN=paste-your-portable-skill-token-here
```

Use `portable-skills.env` for the normal one-token setup, especially when a token grants more than one family. A skill-specific file such as `~/.batshit/portable-skills/artifact-creator.env` is an optional override for users who deliberately want a narrower token for one portable skill.

Do not put real tokens in `batshit-portable-skills/<skill-id>/`, downloaded zips, repo folders, or shared examples.

## Safety

- Never modify Batshit core source or app data roots.
- Never write directly to Redis.
- Never call internal service-token routes.
- Keep secrets server-side in Batshit records.
- Install local runtimes only in user-owned tool roots such as `~/.batshit/installs/<engine-id>/`.
- Register disabled first and enable only after health and smoke proof.
- For Docker Batshit, distinguish host paths, app-container URLs, and browser URLs instead of assuming `localhost` means one thing.

## Drift Control

Shared references are copied from in-app system skill sources by `tools/portable-skills/sync-portable-skills.mjs`.

When a shared in-app reference changes:

```bash
node tools/portable-skills/sync-portable-skills.mjs --write
node tools/portable-skills/sync-portable-skills.mjs --check
```

Do not hand-copy shared references.
