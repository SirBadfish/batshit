# Updating Batshit

Batshit alpha updates are manual for now. There is no automatic in-app updater yet.

When Batshit can reach the internet, it periodically checks the official GitHub release feed. If a newer alpha is available, you will see an update icon in the top header. Open it to see your current version, the latest version, the release link, and a backup-first reminder.

Before updating, export a normal backup:

1. Open Settings -> Admin.
2. Find Backup and Restore.
3. Click Export Backup.
4. Keep the zip somewhere private.

Normal backups exclude saved API keys and tokens by default. That is usually what you want before an update. If you ever use With Secrets, protect that file like a password vault because the zip itself is not encrypted.

## Mac app updates

1. Quit Batshit.
2. Download the newer Mac release from the official GitHub Releases page.
3. Open the DMG.
4. Replace the older `Batshit.app` with the newer one.
5. Open Batshit again.
6. Sign in and confirm your agents, settings, and recent sessions look right.

The Mac app keeps your Batshit data outside the app bundle, under your user Library folder. Replacing the app should not delete your data, but alpha releases can still change storage behavior, so make the backup first.

## Docker updates

From the Batshit folder:

```bash
git pull
./start-docker.sh
```

If you use the optional n8n profile:

```bash
git pull
./start-docker.sh --profile n8n
```

The launcher rebuilds/recreates the needed containers with the current Compose files and keeps your Docker volumes unless you explicitly delete them.

Do not run destructive Docker cleanup commands unless you mean to remove local data. In particular, deleting volumes can remove the Redis data for that Docker instance.

## After updating

Check:

- Batshit opens and you can sign in.
- Your saved agents and model presets are still present.
- Settings -> Admin -> Backup and Restore can still export a backup.
- Any external runtimes you use, like n8n, Local AI, voice engines, or optional Docker add-ons, are still reachable.

If something breaks, use [Bug reports and diagnostics](../troubleshooting/bug-reports-and-diagnostics.md) and attach a diagnostics zip if Batshit opens far enough to export one.

## Turning update checks off

Update checks do not include your chats, prompts, keys, settings, logs, or project files. They only ask for the latest public Batshit release version.

If your instance must stay fully offline, set:

```bash
BATSHIT_UPDATE_CHECK_DISABLED=1
```

Then restart Batshit.
