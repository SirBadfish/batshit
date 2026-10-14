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

The Admin area includes a `Runtimes` section that reports the health of optional runtimes Batshit can use, and offers install or repair actions where they apply. It covers status for the n8n runtime, Pinokio, Agent Browser, Cloudflared, Apple Container on Mac, the Docker Sandbox, the FBX-to-VRMA converter, and Batshit's optional NVIDIA Audio2Face bridge. The Pinokio row only reports whether Pinokio 8.2.0 or newer is installed and running on this computer; Pinokio is optional, and Batshit works the same without it. Audio2Face status distinguishes the bridge process from the separately installed NVIDIA NIM so a running bridge is never mistaken for inference readiness.

The behavior is honest about each environment. For example, the n8n runtime entry is status-only — it checks whether your n8n URL and API key are reachable and reports readiness, rather than pretending Batshit can launch n8n for you. In Docker, runtimes like Agent Browser and Cloudflared appear as sidecar states (active or stopped) and defer start/stop to the approved host operator, instead of offering native installs that wouldn't fit the container. When a runtime isn't available, Batshit shows that clearly rather than hiding it.

On Mac, the Cloudflared installer selects Apple Silicon/arm64 or Intel/x64 to match the app's native architecture. If an existing Cloudflared cannot run because it uses the wrong architecture, the status explains that failure and names the matching platform to select before installing again. Batshit checks the download and the new program's version before replacing the existing installation. If moving the replacement into place fails, Batshit restores the previous files. If that recovery also fails, Batshit keeps both copies, reports their locations, and requires recovery before another install or removal.

## Instance-wide defaults

A few instance-level defaults live in Admin because they apply across the instance rather than to a single agent. These include Web Search and Dynamic Schema Hints (shared caps on how large compact tool-schema summaries get — they affect prompt size and clarity, not permissions).

### Agent Wake-ups

A wake-up is a chat Batshit starts on its own, with nobody typing — one agent asking another to start work now, or an outside program doing the same through a webhook. Full detail in [Agent DMs and wake-ups](../primary-agents/agent-dms-and-wake-ups.md).

Three things live here:

- **Allow Wake-ups** — the master switch for this Batshit. Off means nothing can start a chat on its own; every wake-up waits in the recipient's inbox instead, with the reason recorded. Each agent also has its own "May be woken" switch in Agent Settings.
- **Schedules** — Batshit's own clock: a saved cadence, time zone, and message per agent, fired as a DM at the time you set. Each row can be edited, run once now, paused, or deleted. **Edit** changes its name, timing, time zone, message, kind, and delivery; moving it to another agent requires a new schedule. A run Batshit slept through is not asked about here — that question arrives as a dialog in the chat window the next time you open Batshit. Full detail in [Agent DMs and wake-ups](../primary-agents/agent-dms-and-wake-ups.md).
- **Wake-up Webhooks** — one URL and one token per hook, for n8n or any other outside program. Create a hook, pick the agent it writes to, and copy the token **once**: Batshit stores only a fingerprint of it and cannot show it again. Rows show each hook's agent, delivery default, last use, and count, and you can pause a hook, rotate its token, or revoke it.

A hook's recipient needs **Agent DMs** on, not only "May be woken" — a call writes a real DM record, and an agent with DMs off would have no inbox to see it in.

## Cleanup utilities

**Goon Asset Cleanup** inspects uploaded Goon files and shows each orphan under **Files and Reasons**. An orphan has no current saved reference; that does not prove it was removed intentionally. **Clean Orphans** asks for confirmation, rechecks the inspected eligible files, and removes only those still unreferenced. It also lets you explicitly resume interrupted custom Goon cleanup.

Scene skyboxes, thumbnails, room shells, room textures and props with unknown reference history are **Preserved**, even after cleanup. A failed or partial settings write can erase a Scene reference while leaving its file. The audit has no earlier settings snapshot, so it cannot determine when or why the reference disappeared or safely recreate the Scene. If a Scene is missing, keep its files and review a known backup before using the separate restore workflow. Inspect never changes files or settings.

## In this section

- [Backup and restore](backup-and-restore.md) — export, inspect, and restore Batshit-owned data safely.
- [Agent DMs and wake-ups](../primary-agents/agent-dms-and-wake-ups.md) — the master switch, wake-up webhooks, and what a woken chat looks like.
- [Bug reports and diagnostics](../troubleshooting/bug-reports-and-diagnostics.md) — export a previewed support bundle for GitHub issues.

## Related

- [Skills & Prompts](../skills/overview.md) — per-agent prompts and Skills, versus core system prompts here.
- [Security & trust](../security/overview.md) — the safety posture behind admin-level choices.
- [User](../user/overview.md) — your personal account and preferences, separate from instance-wide Admin settings.
