# Bug reports and diagnostics

When you report a Batshit bug, the most useful attachment is a diagnostics zip from the app.

## Export diagnostics

Fast path:

1. Click the bug icon under the chat bar.
2. Review the Diagnostics preview.
3. Click Download Diagnostics Zip.
4. Attach the zip to your GitHub issue if you are comfortable sharing it.

Manual path:

1. Open Settings -> Admin.
2. Find Diagnostics.
3. Click Export Diagnostics.
4. Review the preview.
5. Click Download Diagnostics Zip.
6. Attach the zip to your GitHub issue if you are comfortable sharing it.

The preview shows the bundle contents before anything downloads. It lists included files, excluded data, log files, and the redaction rules Batshit applied.

## What diagnostics includes

- A manifest that summarizes the diagnostics bundle.
- Runtime context such as Mac app, Docker, or source checkout.
- Batshit version, platform, Node version, and basic health checks.
- A safe environment summary with configured/not-configured flags for secrets, not secret values.
- Recent tails of Batshit log files, capped per file and redacted before export.

## What diagnostics does not include

- Chat messages or session history.
- System prompts, agent prompts, or prompt drafts.
- Uploads, Clips, Artifacts, backups, project files, or source files.
- Saved API keys, service tokens, cookies, passwords, or raw credential records.
- Raw Redis database exports.
- n8n workflow contents or external runtime data.

Logs are still logs, so review the preview before posting the zip publicly. Batshit does not intentionally collect chat history for diagnostics, but any app can theoretically log a small snippet of text around an error. The preview exists so you can check first.

## If Batshit will not open

If you cannot reach Settings -> Admin, open a GitHub issue without the diagnostics zip and say which setup path you use.

For Mac app installs, mention that logs normally live at:

```text
~/Library/Logs/Batshit
```

For Docker installs, mention whether these commands show errors:

```bash
docker compose --env-file .env.docker logs app
docker compose --env-file .env.docker logs batshit-server
docker compose --env-file .env.docker logs redis
docker compose --env-file .env.docker logs n8n
```

Do not paste raw logs publicly if they contain secrets. If you are unsure, describe the visible error first and wait for a maintainer to ask for a safer excerpt.

## Good bug reports

Include:

- Setup path: Mac app or Docker.
- What you clicked or typed.
- What you expected.
- What happened instead.
- A screenshot if the problem is visual.
- The diagnostics zip when Batshit can open far enough to export one.

Bug reports do not need perfect technical wording. Clear steps and a diagnostics zip are enough to make most issues much easier to investigate.

Open the GitHub bug form here: [Report a Batshit bug](https://github.com/SirBadfish/batshit/issues/new?template=bug_report.yml).
