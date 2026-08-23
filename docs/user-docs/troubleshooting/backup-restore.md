# Backup and restore troubleshooting

Batshit backup/restore is an Admin feature. It exports Batshit-owned data into a structured `.zip` bundle and restores it into the current single-user instance.

Restore is not a merge. It's a fresh-instance restore or an explicit replace of current Batshit data.

## What a backup includes

Normal Batshit backups include Batshit-owned records and uploaded files, such as:

- settings
- agents, subagents, groups, and assignments
- sessions, folders, messages, zips, clips, and Execution Viewer snapshots
- model presets, custom providers, local provider records, MCP gateways, CLI tools, skills, and prompts
- artifacts and artifact runtime storage
- Goons, Motion Vault, Closet, scenes, custom icons, and uploaded assets
- voice profiles and voice engine registry references

Normal backups exclude secrets by default.

## What a backup doesn't include

Backups don't silently include external n8n workflows, n8n credentials, project source folders, Local AI model weights, voice engine runtime installs or model files, LiveKit servers/workers, Cloudflared installs or tunnel runtime state, Agent Browser installs/cache, Docker Sandbox state, ComfyUI or other external runtime data, or auth account/password/session records.

Use each external tool's own backup/export process for those.

## Export button does nothing or fails

Check that you're signed in as Admin, the app can reach Redis, batshit-server upload storage is reachable, the browser didn't block the download, and there's enough disk space.

In the Mac app, the Save dialog opens before export starts. Choose a destination and leave the app running while Batshit streams the archive there. Active Goons, retained source packages and Recipe revisions, Motion Vault clips, Closet textures, Hair assets, scenes, Clips, and other uploads can make a valid backup several gigabytes. Before exporting, you can use Settings → Admin → Goon Asset Cleanup to inspect and delete orphaned Goon upload records/files.

If the Mac app reports that the backup's `Content-length` exceeds `1073741824` bytes, that build is using the old blob re-upload path. Update or rebuild the Mac app; increasing `BODY_SIZE_LIMIT` is not the export fix.

## Should I use With Secrets?

The default export excludes provider keys, tokens, and other secrets. That's the safer default. Use With Secrets only when you intentionally need a more complete local recovery file and can protect it like a password vault.

Important limits:

- With Secrets backups contain sensitive credential material.
- The exported key blobs still depend on the target instance using the same `ENCRYPTION_KEY`.
- If the target `ENCRYPTION_KEY` is different, saved encrypted secrets may not decrypt.
- Encrypted backup files are deferred for launch v1.

Store With Secrets backups somewhere private.

## Restore preflight fails

Preflight checks the bundle before Batshit mutates data. Common causes:

- the file isn't a Batshit backup zip
- the zip is corrupt or incomplete
- `manifest.json` is missing
- the backup schema is unsupported
- required Redis record entries are missing
- file paths inside the zip are unsafe
- the backup was created by a future Batshit version this install doesn't understand
- uploaded file assets referenced by records are missing

Fix: try the original backup file again, re-download or re-export if it may be incomplete, update Batshit before restoring if it's from a newer version, and use a complete backup bundle if the error mentions missing files. Don't bypass preflight.

## Restore says it will replace current data

That's expected on a non-empty instance. Restore does not merge — it replaces Batshit-owned data after explicit confirmation, while preserving the current auth/session account records enough to keep you signed in.

Before replacing data:

1. Export a fresh backup of the current instance.
2. Store it somewhere safe.
3. Run restore preflight on the incoming backup.
4. Read the summary.
5. Confirm replace only if you're ready to overwrite current Batshit data.

## Restore completed but provider keys are missing

If you restored a normal backup, secrets were excluded by design. Re-enter them: open Settings → API Keys, re-enter provider API keys, re-enter n8n API/MCP tokens if needed, re-enter tunnel/runtime tokens if needed, and test one small provider call. This is safer than accidentally putting keys into every backup.

## With Secrets restore still has broken keys

Check `ENCRYPTION_KEY`. With Secrets export includes encrypted key blobs, but those blobs depend on the same encryption key being used by the target instance. If you restored into a fresh Docker install with a different `ENCRYPTION_KEY`, the encrypted secrets may not be usable — re-enter the keys manually, or restore with the matching key if this is an intentional exact recovery.

## n8n workflows are missing after restore

Batshit backups don't include external n8n workflows or credentials. After restoring Batshit:

1. Restore/import workflows in n8n.
2. Recreate n8n credentials.
3. Activate workflows.
4. Update Batshit agent/subagent webhook URLs if they changed.
5. Make sure current templates forward `x-batshit-native-tool-token`.
6. Test a small n8n chat.

## Project files are missing after restore

Backups restore Project records and paths, not source code folders. Copy or clone the project files onto the target machine, mount the folder into Docker if using Docker, and update the Project path if it changed.

In Docker restores, host-only paths may be rewritten to:

```text
/workspace
```

Make sure the real files are mounted there.

## Local AI or voice runtime is missing after restore

Backups restore Batshit settings/references — they don't install external runtimes. Reinstall or restart the Local AI or voice runtime, reconnect the base URL in Batshit, re-enter secrets if needed, run health checks, and run one real model/voice test. For Docker, host-local runtimes usually need `host.docker.internal` URLs.

## Goon assets are missing or broken

Backups include active Batshit-owned Goon upload assets, but broken imports can still happen if the backup zip is incomplete, files were already missing before export, restore failed partway and rolled back, or the browser is trying to load an old source-instance URL.

Fix: check the restore result for file-asset warnings, open the Goon record in Settings → Goons, confirm the asset URLs use the current batshit-server host/port, re-upload the Goon package or asset if the backup didn't contain it, and use Goon Asset Cleanup only for orphaned assets — not active broken references you still need. Docker restore should rewrite nested Goon upload URLs to the current public batshit-server URL, such as `http://localhost:5600`.

## Restore seems stuck

Large restores take time because Batshit may be writing Redis records and upload files. Wait if progress is still active, check app logs if there's no progress for a long time, and check disk space and Redis health. Don't refresh during the critical restore step unless the app clearly failed. If Redis writes fail, Batshit's restore path is rollback-aware: it tries to remove imported records and restore previous ones.

## Backup file is too large

Common size sources: active Advanced/Blender Goons, Motion Vault previews, Closet textures, scene skyboxes/room shells/props, many image/file Clips, and large artifact assets.

Use Settings → Admin → Goon Asset Cleanup to remove orphaned Goon upload records/files before export. Also remove unneeded old sessions, clips, and artifacts from inside Batshit when appropriate. Don't manually delete upload files from disk behind Batshit's back unless you're intentionally repairing a broken instance and understand the references.

## Docker restore upload is rejected

Docker app request bodies default to:

```env
BODY_SIZE_LIMIT=1G
```

This limit applies to the incoming restore upload, not backup export. If a trusted local backup is larger and your host has enough memory, raise `BODY_SIZE_LIMIT` in `.env.docker`, recreate the containers, and try again. Current restore materializes and parses the archive in memory, so do not set an enormous or unlimited value casually; batshit-server still applies upload-specific caps after the request reaches the server.

## Restore into Mac app vs Docker

Both are valid targets, but paths differ. Advanced source-checkout repair setups follow the Mac/host path rules.

Mac app: local project paths may be normal host paths, local runtimes may use `localhost`, and uploads live in the host batshit-server upload root.

Docker: project paths should resolve under `/workspace`, host runtimes usually use `host.docker.internal`, uploads are rewritten to the Docker batshit-server public URL, and external runtime installs are still external.

Read preflight warnings — they're there to make path rewrites visible before replacement.

## Safe backup habits

- Export before major upgrades, restores, or risky runtime work.
- Keep at least one normal backup without secrets.
- Use With Secrets only when you can protect the file.
- Export n8n workflows separately from n8n.
- Back up project source code separately.
- Keep notes for local runtimes and model downloads.
- Test restore on a disposable instance before depending on a backup for a critical move.
