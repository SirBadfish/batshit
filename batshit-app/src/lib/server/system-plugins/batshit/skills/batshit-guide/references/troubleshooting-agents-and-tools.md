# Agents and tools troubleshooting

Every Primary Agent and Subagent runs in Batshit on the saved model you pick: an API key, a Local AI runtime, your ChatGPT plan or your Claude plan.

Many tool problems are really permission or runtime-boundary problems.

**"Claude Code CLI Subagents were removed from Batshit."** A leftover Claude Code CLI Subagent can only be deleted, and your Primary Agents no longer see it. To use your Claude plan, create a new Subagent and pick a Claude plan model.

**"Codex CLI Subagents were removed from Batshit."** A leftover Codex CLI Subagent can only be deleted. For ChatGPT models, create a new Subagent with the ChatGPT plan connection or an OpenAI API key.

**"Claude Code CLI presets were removed from Batshit."** A saved Claude Code CLI model preset can no longer be picked for an agent or Subagent. Pick another model, for example a Claude plan model, and delete the old preset in Settings → Models when you like.

## The agent doesn't respond

Check that the provider API key is saved in Settings → API Keys, the selected model preset is available, the provider/model supports the requested features, and rate limits or provider errors are visible. On the Claude plan connection, check that Settings → API Keys → Claude Plan says **Ready**.

## Model or provider is missing

Check that Settings → API Keys has the provider key, Settings → Models has a preset for the provider/model, the agent is using the intended preset, Local AI runtimes are enabled and reachable if the preset is local, and n8n workflows have their provider credentials configured inside n8n.

Saving a key in Batshit helps `API` agents and Batshit-owned services. It doesn't automatically create n8n credentials or CLI login.

## Claude Code is not installed or not signed in

The Claude plan connection needs Claude Code installed and signed in where Batshit runs it. Open **Settings → API Keys → Claude Plan**: the card shows whether Claude Code is installed, which copy Batshit uses (your own or the Batshit-managed one), and whether it is signed in with a Claude plan. If it is not installed, install it from the card; Batshit downloads and manages an official verified copy.


On Windows, Claude Code may print `Paste code here if prompted >` after the browser login. Paste the browser auth code at that prompt, then press Enter. The pasted code may not appear in the terminal, so do not wait for visible text. Do not save or share auth codes in docs or chat.


**"The Claude Code CLI lane was removed from Batshit."** Batshit no longer runs Primary Agents on the Claude Code CLI lane. Delete the old agent and make a new one. To use your Claude plan, pick a Claude plan model for it.

**"Codex CLI agents were removed from Batshit."** Delete the old agent and create a new one with a ChatGPT plan model or an OpenAI API key.


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

1. Refresh the MCP source. Batshit keeps each MCP source's tool list for up to five minutes, so a message doesn't wait on every tool server. A tool you just added on the server side shows up after **Refresh**, after you edit that source's settings, or within five minutes.
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


Then use Batshit's Agent Browser tools/settings, not raw Bash.

## Runtime add-on start/stop fails

Start/stop is allowed only for approved startable add-ons, such as current Docker sidecar/profile entries. Check that the add-on appears in the approved runtime add-on catalog, the host runtime add-on operator is configured, the add-on is startable (not connect-existing), the Compose profile exists, and the operator token matches the app setting/env.

Connect-existing families — real Local AI runtimes, real ComfyUI/Gradio-style services, and generic voice engines — refuse start/stop by design. Connect them by URL instead.

## Artifact tools are invisible to the agent

For an Artifact to appear as an agent tool, it must be published, Agent Use must be enabled, the current agent must be allowed, the Artifact must have typed Fabric fields or run-only metadata, and the power source must have a backend-runnable path.

Current user-only panel artifacts don't become agent tools: HuggingFace embeds, Gradio embeds, and current ComfyUI panel artifacts. Build a backend-runnable Artifact if an agent needs to run it.

## `fetch_zip` fails

Primary Agents fetch a saved Zip through the tool broker: `batshit_tool_use` with ref `fabric:sys.zip.fetch`.

Fetch Zip reaches a Subagent when its Fetch Zip toggle is on. If it is off and the Subagent needs prior zipped content, have the Primary Agent fetch or summarize it, then call the Subagent with the relevant context.

If a Primary Agent cannot fetch a Zip, verify the Zip ID exists in the session, the current agent/session can access it, and the message was saved with trusted Zip references.

## Group Chat behaves oddly

[Group Chat](../groups/overview.md) uses your current Primary Agents. Check that:

- every member is available; a leftover CLI or n8n agent cannot run
- the Group driver is set intentionally
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
