# Backup and restore

Batshit has an Admin backup and restore system for Batshit-owned data. Use it before major upgrades, before risky configuration changes, before moving to another instance, and after you've created important agents, settings, clips, Artifacts, or Goons.

## What a Batshit backup is

A Batshit backup is a structured `.zip` file created by the app. It is not a raw Redis dump. It can include:

- User settings and Admin settings
- Core prompt edits
- Agents, Subagents, Groups, assignments, and model presets
- Sessions, folders, messages, zips, clips, and Execution Viewer records
- MCP gateways, CLI tools, slash commands, skill metadata, and related settings
- Artifacts and artifact ordering/runtime data
- Goons, custom icons, voice profiles, and voice engine registry references
- Batshit-owned uploaded files under the upload store

The export includes a `manifest.json`, Redis record entries, and uploaded file assets.

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

Back up those systems with their own tools.

## Normal export

Use normal Export Backup for most situations.

1. Open Settings → Admin.
2. Find Backup and Restore.
3. Click Export Backup.
4. In the Mac app, choose the destination when the Save dialog opens. Batshit then streams the backup directly to that file.
5. Store the `.zip` somewhere safe.

Normal backups exclude saved provider keys, tokens, and other secrets. After restoring a normal backup, re-enter missing provider keys and reconnect external services as needed.

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
4. Click Inspect.
5. Review the created date, record counts, file counts, secrets status, user remap notes, and warnings.

Inspect validates the bundle before Batshit changes the instance.

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

If you restored without secrets, re-enter API keys in Settings → API Keys.

## Docker notes

Docker Batshit stores core runtime state in Docker volumes, but the app backup is still the normal user-level recovery path for Batshit-owned data.

Use app backups for moving Batshit-owned data between instances, before upgrades, before risky settings changes, and to recover from bad app-level config. Use Docker volume backups or snapshots only when you want exact full-instance rollback, including volume state outside the app backup.

Docker restores rewrite some host-only Project paths to `/workspace` so containerized Batshit can see them. The backup does not copy the project source tree itself — mount or copy project files into the Docker workspace separately.

## Mac app notes

Mac app backups include Batshit-owned uploads when those uploads are in the configured upload store. They do not include:

- The Redis Stack installation itself
- n8n's database or credentials
- Host-installed Local AI or voice runtimes
- Host project source folders
- Host Codex or Claude Code credentials

Back those up with normal host backup tools. Advanced source-checkout repair setups follow the same host-backup boundary.

The Mac app does not impose its 1 GiB incoming-request limit on backup exports. Export streams to a temporary file beside the destination and replaces the destination only after the complete backup finishes. Available disk space and the actual included assets are the practical concerns for large exports.

## Good backup habits

- Export a normal backup after your first working setup.
- Export before upgrades.
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

### Restored n8n agents don't work

Check n8n separately: workflows still exist and are active, n8n credentials still exist, current templates still forward `x-batshit-native-tool-token`, and webhook URLs are reachable from the caller.

### Restored project paths are wrong

Mac app/source-checkout repair and Docker use different file paths. Docker users should mount the project folder and use `/workspace` paths; Mac app users should use host absolute paths.

### Backup file is huge

Large source packages and Live Goons can each contribute hundreds of megabytes. Retained Goon Recipe revisions, Hair assets, Motion Vault assets, Closet items, scenes, Clips, and other uploaded files can also make backups large. That size is expected when the data is active. Use Settings → Admin → Goon Asset Cleanup to inspect orphaned Goon upload records before export; it does not delete referenced assets just to make a backup smaller.

## Related docs

- [First run](../installation/first-run.md)
- [Updating Batshit](../installation/updating-batshit.md)
- [API keys and models](../providers/api-keys-and-models.md)
- [Connect n8n](../primary-agents/connect-n8n.md)
