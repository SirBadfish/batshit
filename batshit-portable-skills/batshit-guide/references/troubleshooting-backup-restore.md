# Backup and restore troubleshooting

Batshit backup/restore is an Admin feature. It exports Batshit-owned data into a structured `.zip` bundle and restores it into the current single-user instance.

Restore is not a merge. It's a fresh-instance restore or an explicit replace of current Batshit data.

## What a backup includes

Normal Batshit backups include Batshit-owned records and uploaded files, such as:

- settings
- agents, subagents, groups, and assignments
- sessions, folders, messages, zips, clips, and Execution Viewer snapshots
- model presets, custom providers, local provider records, MCP gateways, CLI tools, slash commands, and prompts
- your own skills with their files, and each clone voice's reference recording
- artifacts and artifact runtime storage
- Goons, the Motion Vault list, Closet, scenes, custom icons, and uploaded assets
- voice profiles and voice engine registry references
- agent memory
- agent DMs, wake-up webhooks, and schedules

Normal backups exclude secrets by default.

## What a backup doesn't include

Backups don't silently include external n8n workflows, n8n credentials, project source folders, Local AI model weights, voice engine runtime installs or model files, LiveKit servers/workers, Cloudflared installs or tunnel runtime state, Agent Browser installs/cache, Docker Sandbox state, ComfyUI or other external runtime data, or auth account/password/session records.

Use each external tool's own backup/export process for those.

## Export button does nothing or fails

Check that you're signed in as Admin, the app can reach Redis, batshit-server upload storage is reachable, the browser didn't block the download, and there's enough disk space.

In the Mac app, the Save dialog opens before export starts. Choose a destination and leave the app running while Batshit streams the archive there. Active Goons, retained source packages and Recipe revisions, Motion Vault clips, Closet textures, Hair assets, scenes, Clips, and other uploads can make a valid backup several gigabytes. Before exporting, use Settings → Admin → Goon Asset Cleanup to inspect eligible orphans, read **Files and Reasons**, and explicitly confirm cleanup. Referenced files and unknown Scene files marked **Preserved** stay in storage.

If the Mac app reports that the backup's `Content-length` exceeds `1073741824` bytes (1 GiB), update the Mac app, or rebuild it if you build your own copy. Increasing `BODY_SIZE_LIMIT` does not fix this backup-export error.

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
- a saved Goon Recipe has missing build-review records or inconsistent saved-state hashes

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

A custom provider's Extra Header values are left out too, because a header such as `Authorization` often carries a key. The header names come back with the value `null`. Open Settings → API Keys → Custom OpenAI-Compatible, enter the provider's API key, and replace each `null` with the header's value. Inspect lists these headers before the restore.

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

## A skill or clone voice came back without its files

Inspect lists every skill folder and clone voice recording a backup doesn't carry, with the reason:

- The folder or recording was missing when the backup was made, or Batshit couldn't read it.
- A file in the folder changed while the backup was being made.
- The folder is, or holds, a symbolic link. Batshit never follows one.
- A file is over 100 MiB, or the folder is over 500 MiB or 2,000 files.
- The backup came from Docker, where clone voice recordings live on the host computer and Batshit can't read them yet.
- The backup is from an older Batshit that didn't save skill files or voice recordings.

The skill or voice still comes back with its settings. Add the skill's files again (or import the skill again), or record the voice sample again in Voice Studio. A skill whose files are missing says so when it's used; Batshit never replaces it with an empty skill.

## Goon assets are missing or broken

Backups include active Batshit-owned Goon upload assets, but broken imports can still happen if the backup zip is incomplete, files were already missing before export, restore failed partway and rolled back, or the browser is trying to load an old source-instance URL.

Fix: check the restore result for file-asset warnings, open the Goon record in Settings → Goons, confirm the asset URLs use the current batshit-server host/port, re-upload the Goon package or asset if the backup didn't contain it, and use Goon Asset Cleanup only for orphaned assets — not active broken references you still need. Docker restore should rewrite nested Goon upload URLs to the current public batshit-server URL, such as `http://localhost:5600`.

## Restore seems stuck

Large restores first stream the selected archive into private disk staging, then inspect it entry by entry. The button shows staging progress before inspection. Restore itself prepares a separate upload tree and disk-backed Redis rollback before replacing anything, so a multi-gigabyte backup can legitimately take time even when memory stays stable.

Wait if progress is still active, check the preflight disk row, and check app logs if there is no progress for a long time. If Redis or file replacement fails, Batshit restores the previous Redis records and upload tree. If the app stops during the critical step, restart it normally; startup resolves the durable restore journal before Batshit serves ordinary requests.

If Batshit says restore is waiting for active work, stop the current chat send or other long-running task and retry. No restore data has been changed at that point.

If restore reports unfinished Goon asset cleanup or upload, let the current Goon operation finish, run **Settings → Admin → Goon Asset Cleanup**, then retry restore. Cleanup safely resumes interrupted file work. Do not delete upload files or clear Redis records by hand.

If startup says an interrupted restore needs manual recovery, keep its upload and backup-staging folders intact and seek support with the exact error. Batshit stops when it cannot verify the original files or recovery records; deleting those records can destroy the information needed to recover. This can also happen with an unfinished restore from an older build. Older backup ZIP files remain supported separately.

## Backup file is too large

Common size sources: active Advanced/Blender Goons, Motion Vault previews, Closet textures, scene skyboxes/room shells/props, many image/file Clips, and large artifact assets.

Use Settings → Admin → Goon Asset Cleanup to inspect and remove eligible orphaned Goon uploads before export. Scene files with unknown reference history are preserved: a failed or partial settings write could have erased their saved reference, and the audit cannot date that loss or recreate the Scene safely. If a Scene disappeared, keep its files and review a known backup before the separate restore workflow. Also remove unneeded old sessions, clips, and artifacts from inside Batshit when appropriate. Don't manually delete upload files from disk behind Batshit's back unless you're intentionally repairing a broken instance and understand the references.

## Docker restore staging fails

Backup restore does not use Docker's `BODY_SIZE_LIMIT`; that limit still protects ordinary app requests and large product imports. Restore streams directly into the private shared `batshit_backup_restore_staging` volume with a short-lived one-use ticket.

If staging fails, confirm both `app` and `batshit-server` were recreated from the same current Compose file, `PUBLIC_BATSHIT_SERVER_URL` is reachable from the browser, the host has enough free disk space, and the Batshit app origin matches `CORS_ORIGIN`. Do not raise `BODY_SIZE_LIMIT` as a restore fix.

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
