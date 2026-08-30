# Agents and tools troubleshooting

Batshit has two Primary Agent types:

- `API`: chat runs directly through Batshit using saved provider connections.
- `CLI`: chat runs through a managed CLI runtime such as Codex or Claude Code.

Many tool problems are really agent-type, permission, or runtime-boundary problems.

## The agent doesn't respond

First identify the agent type.

For `API`: the provider API key is saved in Settings → API Keys, the selected model preset is available, the provider/model supports the requested features, and rate limits or provider errors are visible.

For `CLI`: the CLI runtime is installed where Batshit runs, the CLI is logged in, the CLI settings/profile generated correctly, and Docker Codex login was performed inside the app container when using Docker.

Use the [Execution Viewer](../chat/execution-viewer.md) when available — it shows what Batshit tried to send and where the run failed.

## Model or provider is missing

Check that Settings → API Keys has the provider key, Settings → Models has a preset for the provider/model, the agent is using the intended preset, Local AI runtimes are enabled and reachable if the preset is local, and n8n workflows have their provider credentials configured inside n8n.

Saving a key in Batshit helps `API` agents and Batshit-owned services. It doesn't automatically create n8n credentials or CLI login.

## CLI agent is locked or unauthorized

First, make sure the CLI is installed at all. If it's not, Agent Settings shows a one-click install card for Codex CLI and Claude Code CLI in the model section — Batshit downloads and manages an official verified copy. Your own existing install (found on PATH) also works.

Native install: check the install card in Agent Settings (it shows which copy Batshit is using — your own, or the Batshit-managed one), confirm the CLI is logged in, and check Agent Settings for the generated profile/config.

Docker install: install through the same one-click card (saved in a persistent Docker volume), then run the login command Batshit shows in Agent Settings. For a Batshit-managed install:

```sh
docker compose --env-file .env.docker exec app /home/batshit-cli/.batshit/installs/cli/bin/codex login --device-auth
docker compose --env-file .env.docker exec --user batshit-cli --env HOME=/home/batshit-cli --env USER=batshit-cli --env LOGNAME=batshit-cli --env SHELL=/bin/sh app /home/batshit-cli/.batshit/installs/cli/bin/claude auth login
```

If using the n8n profile and your Compose commands include `--profile n8n`, include that profile in the login command. An OpenAI `401 Unauthorized` from a Docker Codex run usually means the container-side Codex CLI isn't logged in.

On Windows, Claude Code may print `Paste code here if prompted >` after the browser login. Paste the browser auth code at that prompt, then press Enter. The pasted code may not appear in the terminal, so do not wait for visible text. Do not save or share auth codes in docs or chat.

Docker Claude runs as the non-root `batshit-cli` user so Claude Code Bypass Permissions can work. If a Docker Claude agent still reports that Bypass Permissions cannot run as root, rebuild the app image from current source and use the exact login command shown in Agent Settings.

## Tools are missing from the agent

Check the agent's Tool Grid and access settings. Common causes:

- the tool family is disabled for that agent
- the subagent has its own tool scope and doesn't inherit the Primary Agent's tools
- the MCP gateway or another tool source is stopped
- the saved CLI tool is archived or not selected
- the Artifact isn't published or isn't enabled for that agent
- broad Fabric controls are Primary-Agent-only
- the Docker runtime add-on is connect-existing, not startable

Subagents are assistant runs surfaced as tool-like companions. They're not the same thing as MCP tools.

## Dynamic Tool Search returns nothing

Check that at least one matching tool source is enabled, source health passes, the agent has permission to discover that tool family or source, the selected family/group/gateway/tool scope isn't accidentally empty, the Docker MCP Gateway is actually running if you use it, and the gateway token matches Batshit settings/env.

In Docker, a host MCP gateway is usually reached from the app container through:

```text
http://host.docker.internal:<port>/mcp
```

The browser-facing gateway URL may still show `localhost`.

## MCP tool works directly but not through the agent

The agent may not have discovered or selected it. Try:

1. Refresh the MCP source.
2. Check Tool Grid visibility for that agent.
3. Ask the agent to search for the tool by purpose, not exact internal name.
4. Check whether the tool needs credentials.
5. Check whether the tool schema changed.

If the gateway is optional and currently stopped, Batshit should either use cached stale discovery where available or show a clear unavailable state.

## Saved CLI Tool isn't found

Check that:

- the expected Project is selected in the sidebar, or saved as the agent's default Project when no sidebar Project is active
- the CLI tool record is active, not archived
- the tool is selected or globally discoverable
- the manifest fields are valid
- required env keys are saved
- the executable/script exists in the runtime that will execute it

Docker reminder: the app-container shell is not the host shell. A host path that works on the host may not exist inside Docker unless it's mounted under `/workspace` or handled by a supported host/runtime path.

## Bash tool fails in Docker

Decide which backend you intended:

- `local`: runs inside the app container
- `docker_sandbox`: isolated Docker Sandbox backend through the host operator

If the selected backend is Docker Sandbox and the operator is missing, Batshit should fail with an unavailable/operator message — it should not silently use app-container Bash. If you intended app-container Bash, make sure the files are under `/workspace`.

## Agent Browser fails

Native install: Agent Browser may use the host runtime path. Check Agent Browser settings and runtime status, and check browser/profile/session settings if the host runtime uses them.

Docker install: Agent Browser uses the optional sidecar/controller. It does not use host Chrome cookies or display, and raw app-container `agent-browser ...` Bash commands are blocked. Start the sidecar:

```sh
docker compose --env-file .env.docker --profile agent-browser up -d --build agent-browser
```

Then use Batshit's Agent Browser tools/settings, not raw Bash.

## Runtime add-on start/stop fails

Start/stop is allowed only for approved startable add-ons, such as current Docker sidecar/profile entries. Check that the add-on appears in the approved runtime add-on catalog, the host runtime add-on operator is configured, the add-on is startable (not connect-existing), the Compose profile exists, and the operator token matches the app setting/env.

Connect-existing families — real Local AI runtimes, real ComfyUI/Gradio-style services, and generic voice engines — refuse start/stop by design. Connect them by URL instead.

## Artifact tools are invisible to the agent

For an Artifact to appear as an agent tool, it must be published, Agent Use must be enabled, the current agent must be allowed, the Artifact must have typed Fabric fields or run-only metadata, and the power source must have a backend-runnable path.

Current user-only panel artifacts don't become agent tools: HuggingFace embeds, Gradio embeds, and current ComfyUI panel artifacts. Build a backend-runnable Artifact if an agent needs to run it.

## `fetch_zip` fails

Primary Agents fetch a saved Zip through the tool broker: `batshit_tool_use` with ref `fabric:sys.zip.fetch`.

Fetch Zip is not available for subagent runs in either form. If a subagent needs prior zipped content, have the Primary Agent fetch or summarize it, then call the subagent with the relevant context.

If a Primary Agent cannot fetch a Zip, verify the Zip ID exists in the session, the current agent/session can access it, and the message was saved with trusted Zip references.

## Group Chat behaves oddly

[Group Chat](../groups/overview.md) uses the two live Primary Agent types. Check that:

- the group contains supported agent types
- the Group driver is set intentionally if using Goons
- agent speak policies are sane
- shared tool visibility is intentional
- each agent's model/provider works alone first

If one agent's tool is stuck, the group can feel stuck because turns are sequential.

## Agent can see a tool but shouldn't use it

Review the Tool Grid defaults, agent-specific tool selections, subagent-specific tool selections, MCP gateway scope, Artifact agent allowlist, runtime add-on permissions, and CLI tool archive/discoverability state.

Don't rely on prompt wording alone to protect sensitive tools. Remove access when a tool should not be callable.

## Imported backup changed tool paths

Backups restore Batshit settings and references. They don't guarantee external paths still exist. After restore, check Project paths, CLI tool executable paths, MCP gateway URLs, n8n URLs, and the Docker `/workspace` mapping; reconnect external runtimes; and re-enter secrets if the backup excluded them.

Docker restores may rewrite Project paths to `/workspace`. Make sure the actual source files are mounted there.

## Safe agent/tool rules

- Prefer sandboxed Agent Mode for normal command execution.
- Treat unsandboxed host-power tools as sensitive.
- Read imported Skills, workflows, MCP configs, Artifacts, and CLI tools before enabling them.
- Keep provider keys and with-secrets backups protected.
- Give agents only the tools they need.
- Test new tools with harmless inputs before real work.
