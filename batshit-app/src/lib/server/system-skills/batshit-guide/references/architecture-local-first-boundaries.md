# Local-first runtime boundaries

Batshit runs on your machine, not in a Batshit-operated cloud. This page explains what actually runs where, why the pieces are split the way they are, and what leaves your computer when you use an external provider. It's the architecture-level "why," so it leans on the install and security pages for the concrete steps and stays honest about the tradeoffs — neither launch path is magically safe.

If you haven't picked a way to run Batshit yet, start with [Choose Mac app or Docker](../installation/choose-mac-app-or-docker.md). For the practical security posture, read [Security and trust](../security/overview.md). For exact ports and the full caller table, see [Ports and URLs](../reference/ports-and-urls.md). This page assumes you've met those and only explains the boundaries underneath them.

## Two local launch paths, two boundary shapes

Batshit has two public ways to run: the Mac app and Docker. They run the same product, but they draw the line between Batshit and your computer differently, and that difference is the whole point of having both.

The **Mac app** runs Batshit's local services directly on your Mac. Agents and tools sit closer to your real host files, host-installed tools, and host runtimes. That makes it the richer workstation path — local AI, local voice engines, and host tooling tend to "just work" — but closer access means more trust. There is less standing between an agent and your machine.

**Docker** runs the core stack inside Compose with clearer walls. Redis stays internal, the core app container does not get raw control of your machine's Docker by default, and anything that needs to cross a boundary does so through something explicit: a mounted workspace folder, named sidecar services, or a small host operator that the Docker launcher sets up for sandboxed command runs and approved add-ons. That containment is real, but it isn't a force field — those bridges exist precisely so useful work can cross them, and a careless tool choice can still do damage inside them.

So the honest framing is: the Mac app trades containment for integration, and Docker trades some integration for clearer boundaries. Pick based on how much host access you want to hand the thing, not on a belief that one of them removes the need to think.

## The local services

Whichever path you choose, a few cooperating services run locally for you:

- **The Batshit app** — the web UI plus the server routes behind it. This is what your browser talks to.
- **batshit-server** — the helper service for file operations, uploads, and MCP tool plumbing. It's a separate process from the app on purpose (more on why below).
- **An internal Redis** — where your data lives: chats, agents, prompts, sessions, settings, and the records that tie everything together.
- **n8n** — optional, and only in play when you use workflow tools or n8n Workflow Subagents. You can connect an existing n8n instance or run one alongside Batshit.

In the Mac app these run as host processes the app supervises. In Docker they run as Compose services that find each other by service name on a private network. That second detail is why "localhost" is slippery in Docker: inside a container, `localhost` means *that container*, not your computer, so different callers — your browser, the app container, batshit-server, n8n, a sidecar, a host service — each need the URL that's correct *from where they're calling*. The full caller-by-caller table lives in [Ports and URLs](../reference/ports-and-urls.md); the takeaway here is just that the boundary between "your machine" and "a container" is a real line that URLs have to respect.

## Why browser to file-server calls go through the app

Your browser never talks to batshit-server directly. Browser features reach it only through the Batshit app's own routes, which check your login session first. This is deliberate, and it's worth understanding as a design choice rather than an accident of plumbing.

The idea is **one authenticated front door**. batshit-server can touch files and run helper operations, so leaving it open to direct browser calls would mean a second entrance that has to be defended separately and can drift out of sync. Instead, every browser request goes through the app, the app authenticates it against your session, and only then does the app call batshit-server over a trusted internal path. batshit-server's own working routes stay closed to the outside; only health checks and read-only serving of uploaded files are public.

A related principle holds across the whole system: **each boundary keeps its own secret.** The app-to-server trust path, the optional MCP gateway, the Docker sandbox operator, and the Agent Browser sidecar each use their own credential rather than sharing one master key. The reasoning is blast-radius — if one boundary's secret is ever exposed, it shouldn't hand over every other boundary too. You never need to see or print these values to use Batshit; the point is only that the walls are individually locked, not that one key opens all of them. For the user-facing version of this — sessions, saved keys, sandboxing — see [Security and trust](../security/overview.md).

## What's stored locally

Your content lives on your instance, on your machine. That includes your chats, agents, system prompts, n8n workflows, Artifacts, uploaded files (Clips), project file references, and content your agents generate. Batshit doesn't sync any of it to a Batshit cloud, because there isn't one — the data sits in your local Redis and your local upload storage.

This is the upside of local-first: the durable record of your work is yours, and Batshit's [Backup and restore](../security/overview.md#backups) exports it as a structured bundle you control. It's also the responsibility: nobody else is holding a copy. If your machine dies and you have no backup, that data is gone. External pieces — your n8n credentials, local AI model weights, installed voice engines, project source trees — live outside Batshit's records and need their own backups, which the security page spells out.

## The honest note about external providers

Local-first does not mean nothing ever leaves your machine. The moment you use a cloud model provider, you're talking to that provider.

When you call a hosted model, your request and your saved API key go to that provider, under your own account with them. Batshit does not proxy those calls through a Batshit-operated cloud and does not route your keys through one — your key is stored encrypted on your instance and used to talk to the provider directly. That's good for trust (no Batshit middleman holding your traffic) and it's also the plain truth: an external provider is external. Your prompt content, and whatever context Batshit compiled for that request, goes to them and is governed by their terms, not Batshit's.

If you want to keep even that on your machine, that's exactly what **Local AI** and **local voice engines** are for. A model running in Ollama, LM Studio, oMLX, or a similar local program, or a voice engine running on your host, means the request never leaves your computer. In Docker, those host services are reached through the host-gateway URL rather than `localhost`, since the call originates inside a container — again, a boundary the URL has to account for, covered in [Ports and URLs](../reference/ports-and-urls.md).

## The short version

Batshit is local-first: the app, the helper server, your data store, and optional n8n run on or for your machine, your content stays on your instance, and the browser reaches the file server only through one authenticated front door with each boundary individually locked. The two launch paths draw the host boundary in different places — the Mac app for integration, Docker for containment — and neither is a substitute for choosing tools and permissions carefully. And when you reach out to a cloud provider, you're genuinely reaching out: that traffic and that key go to them, unless you keep it local with Local AI and local voice.

For the next layer down, see the sibling pages in [How Batshit works](overview.md).
