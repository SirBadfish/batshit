# Backup and restore

Batshit has an Admin backup and restore system for Batshit-owned data. Use it before major upgrades, before risky configuration changes, before moving to another instance, and after you've created important agents, settings, clips, Artifacts, or Goons.

## What a Batshit backup is

A Batshit backup is a structured `.zip` file created by the app. It is not a raw Redis dump. It can include:

- User settings and Admin settings
- Core prompt edits, and which core prompts are still Batshit defaults (so a newer Batshit can update those)
- Agents, Subagents, Groups, assignments, and model presets
- Sessions, folders, messages, zips, clips, and Execution Viewer records
- Agent memories, graduated history, and memory-owned photos
- Agent DMs, wake-up webhooks, and schedules
- MCP gateways, CLI tools, slash commands, and related settings
- Your own skills, with their files (`SKILL.md`, scripts, references, and assets)
- Artifacts and artifact ordering/runtime data
- Goons, the Motion Vault, custom icons, voice profiles, the reference recording of each clone voice, and voice engine registry references
- Batshit-owned uploaded files under the upload store

The export includes a `manifest.json`, Redis record entries, uploaded file assets, and the skill and voice files described below.

### Skill files and clone voice recordings

Some of your data lives in folders on the computer rather than in Batshit's database: each of your own skills in `~/.batshit/skills/`, and each clone voice's reference recording in `~/.batshit/voice-profiles/`. A backup carries those folders too, so a restore onto another computer brings back your skills' text and your clone voices' recordings. Built-in skills aren't in the backup; they come with Batshit.

A backup only carries a folder it can copy whole and safely:

- Batshit never follows a shortcut (a symbolic link). A skill folder that is a link, or holds one, stays out of the backup.
- A single file can be at most 100 MiB, and one folder at most 500 MiB and 2,000 files.
- A folder that is missing when you export, or a clone voice whose recording is gone, can't be carried.

When a folder can't be carried, the backup still finishes. The export message names the folders it left out, and Inspect has the complete list, with the reason for each, before a restore. The skill or voice itself still comes back, with its settings but without those files.

Restore replaces only the skill and voice folders that the backup carries. Other folders in `~/.batshit/skills` stay as they are, because another Batshit on the same computer may use them.

If one of those folders is already on this computer, Inspect names it before you restore. Batshit doesn't delete the copy it replaces: it keeps it in a `.replaced-…` folder next to the others, for example `~/.batshit/skills/.replaced-20260927T142436Z-1a2b3c4d/`, and the restore message says where. Delete that folder yourself once you don't need it.

If another Batshit changes one of those folders while the restore is running, the restore stops before it changes anything and asks you to try again.

Every backup carries clone voice recordings, not only With Secrets backups. A voice sample is sensitive personal data, so keep your backup files private.

In Docker, a clone voice's recording lives on the host computer, where the Docker Batshit can't read or write it yet. A Docker backup lists each clone voice as left out, and a restore into Docker brings clone voices back without their recording. Record or upload each sample again in Voice Studio. Skills work fully in Docker.

## What backups don't include

Batshit backups don't silently copy external systems. They do not include:

- External n8n workflows
- n8n credentials
- Local AI servers
- Local model weights
- Installed voice engines or speech model files
- LiveKit servers or workers
- Cloudflared installs or current tunnel state
- Agent Browser installs, browser profile, or sidecar cache
- Docker Sandbox state
- ComfyUI or other external runtime data
- Project source files on disk
- Docker volumes outside the Batshit-owned app export
- ChatGPT plan logins, OAuth tokens and host registration, including in **With Secrets** exports. Model presets travel, but their account selectors grant no access on another instance. Sign in there and select that Mac's account connection.
- The one-run credentials Batshit mints for a Codex or Claude run

Back up those systems with their own tools.

That last one is deliberate and costs you nothing. A run credential names a single agent run that has already ended, so a restored one could only ever prove an agent's identity for a turn nobody is taking. Batshit makes a fresh one for every run. A wake-up webhook's token is the opposite case — it belongs to a hook you created and means to keep — so its fingerprint *is* backed up, and your hooks still work after a restore.

## Normal export

Use normal Export Backup for most situations.

1. Open Settings → Admin.
2. Find Backup and Restore.
3. Click Export Backup.
4. In the Mac app, choose the destination when the Save dialog opens. Batshit then streams the backup directly to that file.
5. Store the `.zip` somewhere safe.

Normal backups exclude saved provider keys, tokens, and other secrets. That includes the values of a custom provider's Extra Headers: a header such as `Authorization` often carries a key, so a normal backup keeps each header's name and leaves its value out. Only a few headers that never carry a key keep their values: `Accept`, `Accept-Language`, `Content-Type`, `User-Agent`, `HTTP-Referer`, `X-Title`, `anthropic-version`, `anthropic-beta`, and `OpenAI-Beta`. After restoring a normal backup, re-enter missing provider keys and reconnect external services as needed. Inspect names every custom provider header whose value you need to enter again.

## Export with secrets

Use With Secrets only when you really need to move saved keys too.

1. Open Settings → Admin.
2. Find Backup and Restore.
3. Click With Secrets.
4. Confirm the warning.
5. Store the backup somewhere private.

With-Secrets backups can include encrypted saved-key blobs. They still depend on the target instance using the same `ENCRYPTION_KEY`. The backup zip itself is not password-protected, so protect it like a password file:

- Don't upload it to public issue trackers.
- Don't attach it to Discord messages.
- Don't store it in a public repo.
- Don't share it in logs.

If you're not sure, use normal Export Backup and re-enter keys manually.

## Inspect before restore

Restore is a replace operation, not a merge. Always inspect first.

1. Open Settings → Admin.
2. Find Backup and Restore.
3. Choose the backup zip file.
4. Batshit stages that file once with visible progress, then inspects the staged copy. Click Inspect again only if you need to repeat validation.
5. Review the archive size, created date, record counts, file counts, secrets status, user remap notes, disk-space requirement, and warnings.

Inspect validates the bundle before Batshit changes the instance. Large file assets stream to private disk staging rather than being loaded into browser or app memory. The disk row includes the new upload tree, validated Redis plan, and a rollback copy of current restorable Redis data; Restore stays disabled when available space is insufficient.

## Restore

Restore replaces current Batshit-owned data with the backup data.

1. Export a fresh backup of the current instance first.
2. Stop active chats or agent runs.
3. Open Settings → Admin.
4. Select the backup zip.
5. Click Inspect.
6. If Batshit says destructive confirmation is required, check the confirmation box.
7. Click Restore.
8. Let Batshit reload.

Restore keeps the current auth account/session alive and remaps backup user-owned data to the current single-user instance.

Batshit reuses the exact content-hashed file that Inspect validated. It prepares files and rollback data before replacement, keeps a durable recovery journal during the critical step, and resolves an interrupted journal before serving normal requests after restart.

When restore starts, Batshit briefly pauses new app requests while already-running work finishes. If a chat send or another long-running task does not finish within 30 seconds, restore stops before changing data and asks you to stop that task and try again.

## After restore

Check these after every restore:

- Can you open Batshit?
- Are agents, sessions, Artifacts, clips, and Goons present?
- Are upload-backed files visible?
- Do normal provider keys need re-entering?
- Does n8n still have its workflows and credentials?
- Are project folders mounted or present?
- Do Local AI and voice runtimes need restarting or reconnecting?
- In Docker, are optional profiles and sidecars running if you need them?

If you restored without secrets, re-enter API keys in Settings → API Keys. For a custom provider, open Settings → API Keys → Custom OpenAI-Compatible, enter its API key, and replace each Extra Header that shows `null` with its value.

If Inspect said a backup is from a Batshit that didn't save skill files or clone voice recordings, those skills and voices came back with their settings only. If their folders aren't already on this computer, a skill says its files are missing when it's used, and a clone voice has no recording. Add them again, or delete them.

If Inspect said some core prompts "will show as customized", the backup came from a Batshit that didn't record which prompts were its defaults. Batshit keeps that text, because it may be your edit. If you never edited one of them, open Settings → Admin → Core System Prompts and click its Reset.

## Docker notes

Docker Batshit stores core runtime state in Docker volumes, but the app backup is still the normal user-level recovery path for Batshit-owned data.

Use app backups for moving Batshit-owned data between instances, before upgrades, before risky settings changes, and to recover from bad app-level config. Use Docker volume backups or snapshots only when you want exact full-instance rollback, including volume state outside the app backup. Stop Batshit first (`docker compose --env-file .env.docker stop`): Redis keeps its data in an append-only file that it rewrites now and then, and a copy taken during a rewrite may not load.

Docker restores rewrite some host-only Project paths to `/workspace` so containerized Batshit can see them. The backup does not copy the project source tree itself — mount or copy project files into the Docker workspace separately.

## Mac app notes

Mac app backups include Batshit-owned uploads when those uploads are in the configured upload store. They do not include:

- The Redis installation itself
- n8n's database or credentials
- Host-installed Local AI or voice runtimes
- Host project source folders
- Host Codex or Claude Code credentials

Back those up with normal host backup tools. Advanced source-checkout repair setups follow the same host-backup boundary.

The Mac app does not impose its 1 GiB incoming-request limit on backup exports. Export streams to a temporary file beside the destination and replaces the destination only after the complete backup finishes. Available disk space and the actual included assets are the practical concerns for large exports.

Restore also does not send the complete archive through the app's 1 GiB request boundary. The chosen file streams once to Batshit's private staging directory and is read from disk for Inspect and Restore.

## Good backup habits

- Export a normal backup after your first working setup.
- Export before upgrades. The alpha update that moves Batshit to Redis 8 is one-way once it launches, so read the [Redis 8 release note](../installation/updating-batshit.md#alpha-release-note-batshit-now-runs-redis-8) before you update.
- Export before restoring someone else's backup into a disposable test instance.
- Keep With-Secrets backups rare and private.
- Keep your project code in Git.
- Export n8n workflows separately from n8n when they matter.
- Keep a note of external runtimes you installed or connected.

## Troubleshooting

### Restore says the backup is invalid

The file may not be a Batshit backup zip, may be corrupt, may be missing `manifest.json`, or may use an unsupported future schema. Try another backup file. Don't unzip and hand-edit records unless you're intentionally doing recovery work.

### Restore succeeds but provider calls fail

Normal backups exclude keys — re-enter them in Settings → API Keys. If you used With Secrets, confirm the target instance has the same `ENCRYPTION_KEY`.

### Restored n8n Workflow Subagents don't work

Check n8n separately: workflows still exist and are active, n8n credentials still exist, current templates still forward `x-batshit-native-tool-token`, and webhook URLs are reachable from the caller.

### Restored project paths are wrong

Mac app/source-checkout repair and Docker use different file paths. Docker users should mount the project folder and use `/workspace` paths; Mac app users should use host absolute paths.

### Backup file is huge

Large source packages and Live Goons can each contribute hundreds of megabytes. Retained Goon Recipe revisions, Hair assets, Motion Vault assets, Closet items, scenes, Clips, and other uploaded files can also make backups large. That size is expected when the data is active. Use Settings → Admin → Goon Asset Cleanup to inspect eligible orphaned Goon uploads before export. Read **Files and Reasons** before confirming cleanup. Referenced assets and Scene files marked **Preserved** stay in storage and in the backup; the audit cannot prove that an unknown Scene reference was removed intentionally.

## Related docs

- [First run](../installation/first-run.md)
- [Updating Batshit](../installation/updating-batshit.md)
- [API keys and models](../providers/api-keys-and-models.md)
- [Connect n8n](../primary-agents/connect-n8n.md)
