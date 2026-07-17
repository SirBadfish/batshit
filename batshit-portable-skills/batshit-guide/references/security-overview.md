# Security and trust

Batshit is powerful because it connects AI agents to files, tools, workflows, browsers, Artifacts, voice runtimes, and local services. That power needs honest boundaries.

This page explains the security model in plain English. It's not a legal promise, a full security audit, or a guarantee that every setup is safe. Batshit is launching as an alpha, so expect sharp edges, report bugs, and choose setup options with care.

Batshit is planned as open source under AGPL-3.0-only. The Batshit name, logo, mascot, and visual identity are protected separately, so the code license doesn't grant brand rights. Your chats, agents, prompts, workflows, Artifacts, uploaded files, project files, generated content, and local data remain yours. Using Batshit doesn't make your n8n workflows, prompts, Artifacts, or generated content AGPL-licensed Batshit code. Batshit integrates with n8n, which is separately licensed by n8n.

## Single-user per instance

Batshit is currently a single-user-per-instance app. That means:

- One Batshit instance is intended for one owner/operator.
- "Users" in these docs means people running their own separate Batshit instances.
- It does not mean several unrelated people sharing one instance.

Don't treat Batshit as a multi-tenant team SaaS unless future docs say that's changed.

## Mac app and Docker are peer paths

Batshit supports Mac app and Docker setup paths. Neither is magically "safe" in every situation.

**Mac app Batshit** runs local services directly on your Mac. It integrates with host-local runtimes and tools more naturally and is the richer local AI workstation path — which also means it requires more trust, because Batshit and agents may be closer to your host files, tools, and environment.

**Docker Batshit** runs the core app, batshit-server, and Redis in Compose. It's more contained and reproducible, keeps Redis internal by default, and doesn't put the host Docker socket into the core app container by default. It still has explicit bridges for useful local work, like `/workspace`, app-container Bash, optional sidecars, and the host operator.

Use the Mac app when you want maximum workstation integration on macOS and understand the trust level. Use Docker when you prefer clearer packaging, containment, or cross-platform setup. Both still require careful tool choices.

## Where your data lives

Your chats, agents, prompts, workflows, Artifacts, uploads, project records, and generated content live on your own instance — on your machine, not a Batshit-operated cloud. When you use a cloud model provider, your requests and your API keys go to that provider under your own account; Batshit doesn't route your keys through a Batshit cloud. Local AI and local voice engines keep even that on your machine.

Browser features never talk to the file server directly — they go through the app's session-authenticated routes, so there's one authenticated front door rather than several open ones, and each boundary keeps its own secret. The deeper boundary model is in [Local-first runtime boundaries](../architecture/local-first-boundaries.md).

## Ports and local services

Launch-facing local defaults:

| Service | Browser-facing default |
| --- | --- |
| Batshit app, Mac app browser companion | `http://127.0.0.1:5620` |
| Batshit app, Docker host | `http://localhost:5620` |
| Batshit app, source-checkout dev host | `http://localhost:5621` |
| batshit-server, Mac/Docker host | `http://localhost:5600` |
| batshit-server, source-checkout dev host | `http://localhost:5610` |
| n8n | `http://localhost:5678` |

Inside Docker, services call each other by Compose name (for example `http://app:3000` and `http://batshit-server:5600`); see [Ports and URLs](../reference/ports-and-urls.md) for the full caller table.

Don't expose local ports to the public internet casually. If you use tunnels, reverse proxies, or cloud hosts, treat that as a deployment/security decision, not a normal local setup detail.

## Login and sessions

Batshit uses browser login sessions. Session cookies are HTTP-only, so normal browser JavaScript can't read them directly. Local HTTP installs use local-friendly cookie settings so login works on `localhost`; HTTPS deployments should use secure cookies. If you put Batshit behind a reverse proxy, configure the public origin and cookie security intentionally.

## Saved API keys

Provider API keys and custom provider secrets are stored encrypted, not as plain text. Keep the encryption key stable for the lifetime of the instance.

- Don't paste provider keys into chat — save them in Settings instead.
- Be careful with backups that include secrets.
- If you rotate instance secrets incorrectly, saved encrypted keys may become unusable.

Docker note: the internal service token and encryption key are runtime-managed through the Docker environment. Rotate them deliberately and recreate/restart containers as required.

## Backups

Admin backup/restore exports a structured Batshit `.zip` bundle. Normal backups exclude saved provider keys and tokens by default. A With Secrets backup is available behind explicit confirmation, but it must be protected like a password vault.

Restore is *replace*, not *merge*. It's meant to restore an instance deliberately, not blend two instances together.

Backups include Batshit-owned records and uploaded files. They do not silently include external n8n workflows or credentials, project source folders, Local AI model weights, installed voice engines or runtime folders, LiveKit servers or workers, Cloudflared installs or tunnel state, Agent Browser sidecar state, Docker Sandbox state, or external ComfyUI/sidecar data. After a restore, expect to reconnect or reinstall external runtimes — and re-enter missing keys if you used a normal secret-excluded backup.

## Projects and files

Projects point Batshit at folders. Project records are references to files, not copies of the source tree.

- Exclude `.env`, `.git`, keys, credentials, build output, dependency folders, and logs unless you intentionally need them.
- Mention only files you're comfortable sending as context.
- Upload media as Clips instead of pasting raw image data into prompts.
- In Docker, remember that agents usually work under `/workspace`.

Project rules guide AI behavior. They are not a filesystem security boundary.

## Agent command execution

Agents can be allowed to run commands. This is useful and risky. For normal agent work, prefer sandboxed Agent Mode when it's available — sandboxed execution is designed to isolate command runs better than direct host execution.

Know the difference:

| Execution shape | What it means |
| --- | --- |
| Apple Container | The default Mac app sandbox backend for agent command execution on supported Macs. |
| Docker Sandbox | Batshit's isolated command backend for agent work, with a dedicated operator path in Docker installs. |
| Native host command execution | Commands run with normal host access. Powerful and trusted. |
| Docker app-container shell | Commands run inside the Batshit app container against mounted workspace paths. Useful, but not the host shell and not the Docker Sandbox. |

Sandboxed command backends must not silently downgrade into local shell execution. If Apple Container or Docker Sandbox is selected but unavailable, Batshit shows an unavailable/setup-required state.

## Tools, MCPs, Skills, and workflows

Treat tools as code-execution or remote-action surfaces. Be careful importing MCP gateways, STDIO MCP servers, saved CLI Tools, Skills, n8n workflows, Artifacts, and runtime add-ons. Only import things you trust or have inspected — a malicious workflow or tool can exfiltrate data, call external services, write files, or ask an agent to do harmful work.

Tool Grid settings help narrow what each agent can discover. Use them.

Batshit-native capabilities an agent can operate go through [Fabric](../fabric/overview.md), where actions are risk-gated — some run directly, some ask for confirmation, and some are restricted. That gating is a safety rail, not a substitute for choosing trustworthy tools in the first place.

Skills aren't just visible menu items. If a Skill is enabled for an agent, the agent may load it when a matching request comes up, even if you didn't type the slash command. Treat enabled Skills like trusted instructions for that agent.

## Artifacts

Artifacts run in sandboxed iframes and use scoped runtime tokens for Batshit APIs. That's safer than giving Artifact JavaScript direct access to the whole app, but it's not a reason to run untrusted code casually.

- Don't import random Artifact HTML from strangers without review.
- Don't allowlist API keys for an Artifact unless it truly needs them.
- Use backend-runnable Artifacts for agent tools, not user-only embeds forced into tool shape.
- Keep webhook URLs intentional.

HuggingFace/Gradio embeds and current ComfyUI panel Artifacts are user-run panel runtimes, not agent-use tools.

## Clips, uploads, and tunnels

Clips are stored locally. At send time, Batshit may use the local bytes as a structured data URL or combine the clip's upload path with a configured tunnel URL for models/runtimes that need fetchable URLs.

Be careful with sensitive screenshots, documents with private data, and tunnel URLs that expose local files through a public temporary address. batshit-server defaults to local/trusted-origin behavior for helper service access — if you expose it beyond localhost, that's a deployment decision that should be reviewed.

## n8n

n8n is powerful: it can hold credentials, call APIs, run nodes, and expose webhooks.

- Keep n8n credentials in n8n.
- Current official Native Tools use Batshit's short-lived `x-batshit-native-tool-token` payload header.
- Don't share raw workflow exports without sanitizing credential refs and source-instance metadata.
- The optional Docker n8n profile is optional; existing n8n is first-class.
- If one n8n instance is shared between multiple Batshit instances, manage reachable URLs intentionally. The scoped native-tool token prevents static credential drift for current official templates.

## Local AI and voice runtimes

Local AI and voice engines can run on the host, in sidecars, or on other machines.

- Connect existing services by explicit URL.
- Health-check before enabling.
- Keep model weights and runtime folders backed up separately if you need exact recovery.
- Don't let agents install arbitrary runtime containers unless Batshit has an approved sidecar/operator path for that runtime.
- Treat cloned voice reference audio as sensitive personal data.

## Practical safety checklist

Before giving an agent a powerful task:

1. Pick the narrowest Primary Agent type and tool scope that fits.
2. Make sure the active Project path is the folder you intend.
3. Check Project exclusions.
4. Prefer sandboxed command execution for normal agent work.
5. Avoid broad MCP/CLI tool access unless needed.
6. Don't attach Clips with sensitive data unless the chosen model/runtime should see them.
7. Review imported workflows, Artifacts, Skills, and tool definitions.
8. Use Execution Viewer when you need to inspect what happened.
9. Export a normal backup before major changes.
10. Use With Secrets backups only when you can store the file securely.

## What alpha means

Batshit alpha means:

- It's meant for early adopters.
- There may be bugs.
- Some docs will still evolve.
- You should report issues.
- Setup truth matters more than pretending every path is polished.

Batshit fails clearly when a boundary is missing rather than silently pretending an unsafe fallback is fine.

## Related docs

- [Primary Agents](../primary-agents/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Fabric](../fabric/overview.md)
- [Projects and files](../projects/overview.md)
- [Artifacts](../artifacts/overview.md)
- [Voice](../voice/overview.md)
- [3D Goons](../goons/overview.md)
- [Local-first runtime boundaries](../architecture/local-first-boundaries.md)
- [Backup and restore](../admin/backup-and-restore.md)
