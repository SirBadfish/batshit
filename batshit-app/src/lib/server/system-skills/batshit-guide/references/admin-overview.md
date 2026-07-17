# Admin

The Admin area is where the person running a Batshit instance manages the things that affect the whole instance: core system prompts, backup and restore, runtime status, instance-wide defaults, and cleanup utilities. It lives at Settings → Admin. This page explains what that area covers and links the detail pages.

Batshit is single-user-per-instance for alpha, so there's one admin: you. The Admin area isn't about managing other people — it's the control room for the instance itself, kept separate from per-agent and per-chat settings because the choices here are bigger and can affect how everything behaves.

## Core system prompts

Batshit's core system prompts — the foundational prompts that keep tools, Skills, zips, and voice working correctly — are managed here as public, admin-editable settings, with packaged defaults shipped in the app.

This is powerful and worth respecting. Editing a core prompt can change how the whole product behaves, and a bad edit can break tools, Skills, zips, or voice. Batshit shows the packaged default metadata and lets you reset a prompt back to default without silently overwriting a customization you made on purpose. If you're not sure, leave the core prompts alone — your per-agent system prompts (in Settings → Skills & Prompts and Agent Settings) are the normal place to shape behavior.

## Backup and restore

Backup and restore is the app-owned way to export and re-import your Batshit data as a structured `.zip`. Normal exports exclude saved secrets; an explicit "With Secrets" option exists when you really need to move keys. Restore is a **replace** operation, not a merge, so Batshit shows you the backup's contents first and requires an explicit confirmation before it changes the instance.

This is the most important Admin habit to build early: export a backup once after your first working setup, and again before upgrades or risky changes. Full guidance, including what is and isn't included and how Docker and Mac app paths differ, is in [Backup and restore](backup-and-restore.md).

## Diagnostics

Diagnostics is the safe support-bundle export for bug reports. It previews exactly what will be exported, then downloads a zip with runtime context, health checks, selected non-secret environment status, and recent redacted log tails. It does **not** collect chat history, prompts, uploads, project files, backups, saved keys, tokens, cookies, raw Redis data, or n8n workflow contents. See [Bug reports and diagnostics](../troubleshooting/bug-reports-and-diagnostics.md).

## Runtime status and installers

The Admin area includes a `Runtimes` section that reports the health of optional runtimes Batshit can use, and offers install or repair actions where they apply. It covers status for the n8n runtime, Agent Browser, Cloudflared, Apple Container on Mac, the Docker Sandbox, and the FBX-to-VRMA converter.

The behavior is honest about each environment. For example, the n8n runtime entry is status-only — it checks whether your n8n URL and API key are reachable and reports readiness, rather than pretending Batshit can launch n8n for you. In Docker, runtimes like Agent Browser and Cloudflared appear as sidecar states (active or stopped) and defer start/stop to the approved host operator, instead of offering native installs that wouldn't fit the container. When a runtime isn't available, Batshit shows that clearly rather than hiding it.

## Instance-wide defaults

A few instance-level defaults live in Admin because they apply across the instance rather than to a single agent. These include defaults for the Execution Viewer, Web Search, and Dynamic Schema Hints (shared caps on how large compact tool-schema summaries get — they affect prompt size and clarity, not permissions).

## Cleanup utilities

Admin also holds cleanup tools, including Goon Asset Cleanup, which inspects uploaded Goon files that aren't referenced by any current Goon, Motion Vault, Closet, or Scene, and lets you remove orphaned files deliberately. This is handy when backups or storage have grown large because of unused Goon assets.

## In this section

- [Backup and restore](backup-and-restore.md) — export, inspect, and restore Batshit-owned data safely.
- [Bug reports and diagnostics](../troubleshooting/bug-reports-and-diagnostics.md) — export a previewed support bundle for GitHub issues.

## Related

- [Skills & Prompts](../skills/overview.md) — per-agent prompts and Skills, versus core system prompts here.
- [Security & trust](../security/overview.md) — the safety posture behind admin-level choices.
- [User](../user/overview.md) — your personal account and preferences, separate from instance-wide Admin settings.
