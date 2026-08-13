# Tools, MCPs, CLI Tools, and Skills

Tools and Skills let agents do work beyond plain text chat. A tool might search the web, run a command, call an n8n workflow, inspect an MCP server, open Agent Browser, invoke an Artifact, or start an approved runtime add-on. A Skill teaches an agent a heavier workflow with saved instructions and reference files.

This page explains the user-facing pieces without requiring you to understand every internal route.

## The short version

- MCP tools come from MCP gateways.
- Dynamic Tool Search lets an agent find an MCP tool, saved CLI Tool, Artifact runtime tool, Fabric control, or Agent Browser capability only when it needs one.
- CLI Tools are Batshit-saved scripts or executables with structured inputs.
- Skills are reusable instruction bundles. If a Skill is enabled for an agent, the agent may load and use it when your request clearly matches.
- Portable Skills are Batshit-owned skill bundles you install into an outside coding agent so it can operate your local Batshit instance with a scoped Portable Skill Token.
- Fabric controls are Batshit-native app actions, like Artifact management or approved runtime add-ons.
- Subagents are not general tools, even though the Primary Agent calls them through a tool-like mechanism.
- The Tool Grid controls what each agent can discover and how large outputs are zipped.

## Tool vocabulary

| Term | What it means |
| --- | --- |
| Tool | Something an agent can call to do work. |
| MCP | Model Context Protocol, a standard way for AI tools to expose actions. |
| MCP gateway | A source that exposes one or more MCP tools to Batshit. |
| Dynamic Tool Search | Batshit's search-then-use pattern for discovering MCP, CLI Tool, Artifact, Fabric, and Agent Browser capabilities on demand. |
| CLI Tool | A saved local command or script with a manifest, inputs, and boundaries. |
| Skill | A reusable instruction bundle an enabled agent may load when the request fits. |
| Fabric control | A Batshit-native app capability exposed through a safe find/use contract. |
| Tool Grid | The settings surface where you choose discoverability and Zip behavior. |
| Runtime add-on | An approved optional service such as Cloudflared, Agent Browser, LiveKit, or a worker sidecar. |

## MCP gateways

An MCP gateway is a source of MCP tools. Batshit works with several gateway types:

- Docker MCP Gateway.
- n8n MCP Trigger gateways.
- n8n Instance MCP.
- Custom streamable HTTP gateways.
- STDIO gateways launched from an explicit command.

Each gateway can expose many tools, and you rarely want every tool dumped into every prompt. So Batshit exposes MCP tools through Dynamic Tool Search: the agent gets a compact discovery path, searches for the specific tool it needs, then calls the result.

## Dynamic Tool Search and Use

Dynamic Tool Search is a two-step pattern:

1. **Search** — the agent searches discoverable capabilities by query, family, group, or exact name.
2. **Use** — the agent calls the selected result with the required input.

Search results are labeled by family so the agent knows what it found:

- `mcp:` for MCP gateway tools.
- `cli:` for saved CLI Tools.
- `artifact:` for published Artifact runtime tools.
- `fabric:` for Batshit-native controls.
- `agent_browser:` for Agent Browser capabilities, where that runtime supports them.

The key habit is exactness: the agent uses the exact ref that search returned. If search returns `mcp:github.search_issues` or `artifact:use.artifact.storyboard`, the use step calls that exact ref with the required input. The backend validates every call, so compact schema hints help the agent but don't replace permissions or safety checks.

Why it works this way:

- Prompts stay smaller.
- You can install many MCP tools, CLI Tools, and published runtime tools without overwhelming every agent.
- Each agent can have a different discoverability scope.
- The agent gets schema hints only when it needs them.

If an agent can't find a tool, check the Tool Grid and gateway health before assuming the tool doesn't exist.

## The Tool Grid

The Tool Grid is the main control surface for agent tool access and Zip behavior. Depending on where you open it, it controls:

- Global defaults.
- Primary Agent defaults.
- Subagent defaults.
- Chatbar overrides for the current conversation.
- Skill-specific tool scope.
- Group tool sharing.

Common controls:

- **Discoverable** — whether the agent may find or use that tool family.
- **Display detail** — how much tool information appears in the dynamic context shown to the agent.
- **Zip buffer** — how many previous agent/assistant responses stay expanded for model context. It doesn't count user messages or each tool call separately.
- **Zip threshold** — minimum token size before `Normal` behavior may zip content. Most defaults use `0`.
- **Zip behavior** — `Inherited` follows the parent/default when there's a real one to inherit from, `Normal` uses buffer and threshold, `Auto` zips immediately by default, and `Off` never zips.
- Default and inherited values appear as quiet placeholder text; a typed-looking value means that row is overriding its parent/default.
- **Batshit Tools** holds the built-in first-party lanes: file tools, Bash, Web Search, Fetch Zip, Subagent Call, Dynamic Tool Search, Artifact Tools, Fabric Controls, and Agent Browser Actions.
- CLI Tools and each MCP Source appear as their own top-level rows below Batshit Tools.
- Other tool handling sits at the bottom, usually as the single All Other Tools row.
- Group header rows (Batshit Tools, CLI Tools, MCP) can apply Zip Buffer and Zip Threshold to every child row underneath; individual rows can override their own details where the UI shows a per-tool control.
- Tool Notes and Zip permissions, where available.

The Global Tool Grid has `Reset to defaults`. The Agent Tool Grid has `Reset to global settings`, which clears the agent's own Tool Grid and Zip overrides so it inherits global behavior again.

Keep tool access as narrow as the job allows. Broad access is powerful, but it also makes agent behavior harder to predict.

### The Fabric Controls and Artifact Tools rows

Most people never need to touch these two. They're already set the way they should be, and this section is here for the times you're curious what they are or you want to turn one off.

You'll find both inside the **Batshit Tools** group, on the rows already named `Fabric Controls` and `Artifact Tools`.

**Fabric Controls** are Batshit's own app actions, the things that let an agent manage Artifacts, install a CLI Tool, look at your model catalog, and so on. There are around forty of them, and they all live in one row.

**Artifact Tools** are the Artifacts you've published and marked as agent-usable. Each one shows up as something the agent can run directly.

Each row carries the same controls as everything else in the grid:

- **Discoverable** decides whether the agent may find and use that family at all. Turn it off and the whole family disappears for that agent.
- **Display detail** decides how much shows up in the compact capability list Batshit gives the agent on every message.
- The **Zip** columns work like every other Batshit Tools row: they control how the results of a search get compressed in the conversation, not what the agent can reach.

The two rows ship with different display detail on purpose, because they're different sizes:

- **Fabric Controls** shows **the group name only**. Around forty entries is too many to list on every single message, and listing them would cost you real tokens for something the agent can find in one search anyway. The agent still reaches all of them, it just searches instead of being handed the full list.
- **Artifact Tools** shows **names and hints**. This family is small and it's yours, so spelling out each Artifact's input fields is worth it: the agent can call your Artifact directly instead of spending an extra round trip searching for it first.

Discoverable and Display detail only appear when the family is actually reachable for that agent. If Fabric is switched off for an agent entirely, the row keeps its Zip settings and drops the other two controls.

The Chat Bar tool grid works the same way, since it's the same grid. Subagent Settings doesn't have a Batshit Tools group, so the two families appear there as their own rows instead, with the same controls. Group Settings is a different grid that only decides whether a tool's results are shared into the thread, so it has nothing to set here.

If you do change one, the most useful move is usually turning **Artifact Tools** display detail down when you have a lot of published Artifacts and only a few matter to that agent, or turning **Discoverable** off entirely for an agent that has no business managing your app.

## Skills and Prompts

Skills are reusable instruction bundles with optional reference files and scripts. They differ from CLI Tools: a Skill teaches an agent a *workflow*, while a CLI Tool *runs* a saved command or executable.

You can invoke a Skill explicitly with its slash command, but that's not the only path. When a Skill is enabled for an agent, that agent may load and use it on its own when your request clearly matches the Skill's purpose. In other words, enabling a Skill is permission for the agent to use it — not a promise it stays dormant until you type the slash command.

Keep enabled Skills trusted and relevant to that agent. Batshit uses its normal skill-loading path, and normal tool, saved-key, and sandbox boundaries still apply to anything the Skill tells the agent to do.

## Portable Skills

Portable Skills are the outside-agent version of Batshit system skills. Instead of running inside a Batshit chat, they are installed into an agent you already use, such as Claude Code, Codex, or another coding assistant.

They call your local Batshit instance through the app API with a Portable Skill Token from Settings -> Skills & Prompts -> Portable Skills. That token is scoped by family, such as Voice Engines, Artifacts, CLI Tools, Skills, or Goon Scenes.

Use Portable Skills when you want an outside agent to do setup work for Batshit without giving it `BATSHIT_TOKEN`, your password, browser cookies, or direct Redis access. Start with [Portable Skills](../skills/portable-skills.md).

## CLI Tools

A Batshit CLI Tool is not just shell text in a prompt. It's a saved tool record with:

- A name and description.
- A command or executable path.
- Structured input fields.
- Saved-key references when secrets are needed.
- Working-directory and boundary settings.
- A test path.
- An icon.

Use CLI Tools for a repeatable local action that agents should call safely and consistently.

Most CLI Tool setup is best handled through an agent or the CLI Tool Creator flow, because the record includes command shape, validation, permissions, and runtime boundaries. Settings still shows the saved details and user-facing controls — icon, status, tests, permissions — but normal users shouldn't need to hand-author raw manifests.

Good examples:

- Run a repo-specific formatter.
- Convert a file through a known local script.
- Query a local helper with fixed arguments.
- Call a trusted internal command with a narrow input schema.

Avoid CLI Tools for vague, open-ended shell access. If the agent needs general command work, use the right Bash or CLI Primary Agent path with the appropriate sandbox/back-end setting.

## Fabric controls

Fabric controls are Batshit-native actions exposed to agents through a compact find/use contract. Examples:

- Create or update Artifacts.
- Publish an Artifact.
- Use approved runtime add-on actions.
- Manage saved CLI Tool records through the CLI Tool Creator flow.
- Work with Voice Engine Manager records, where supported.

Fabric is for Batshit app capabilities; MCP is for external/user-installed tool servers. Keeping them separate makes the system easier to reason about.

## Published Artifact runtime tools

Some published Artifacts become tools that agents call. These use the Artifact runtime path, not the general Artifact editing path.

To be agent-usable, an Artifact must be published and have a runtime contract Batshit can validate — typed Fabric fields or a run-only action. User-only panel runtimes, like raw HuggingFace/Gradio embeds and current ComfyUI panel artifacts, are not agent tools.

Artifact runtime calls render as normal tool results in chat. Zip settings treat Artifact discovery and Artifact execution as their own rows — **Artifact Tools** and **Artifact Use** — which control whether that output stays expanded or is compressed like other tool output.

See [Artifacts](../artifacts/overview.md) for details.

## Runtime add-ons

Runtime add-ons are optional services Batshit can connect to, start through an approved operator, or guide you to start manually. Current Docker add-on shapes:

- Startable sidecar/worker/profile entries such as Cloudflared, FBX-to-VRMA, Agent Browser, LiveKit, and `comfyui-validation`.
- Connect-existing entries such as real ComfyUI/Gradio-style services, Local AI runtimes, and voice engines.
- Deferred entries that should fail clearly instead of pretending to work.

The Docker core app container does not get arbitrary host Docker control. Start/stop actions go through Batshit-approved add-on IDs and an authenticated host operator when that path is configured.

## How tools reach each Primary Agent type

| Primary Agent type | Tool path |
| --- | --- |
| `n8n` | Uses the Batshit Tools automation pack inside n8n, plus n8n-native workflow tools. |
| `API` | Uses Batshit native tools through the direct provider path. |
| `CLI` | Uses CLI-native command/search/edit behavior plus Batshit-managed helper tools through a managed bridge. |

The user-facing result should feel similar, but the transport differs. If a tool works for one type and not another, check that it's enabled for that agent type and that the runtime path is configured.

## Agent Browser

Agent Browser is Batshit's browser automation runtime.

Mac app Batshit can use the host Agent Browser path where configured. Docker Batshit uses an optional `agent-browser` sidecar/controller that runs its own headless Chromium — it does not use your host Chrome profile, cookies, or visible browser window.

In Docker, raw app-container Bash commands like `agent-browser ...` are blocked. Use Batshit's Agent Browser tools/settings so the request routes through the sidecar.

## n8n tools

n8n can participate in several ways:

- An `n8n` Primary Agent workflow can call tools inside n8n.
- `API` and `CLI` Primary Agents can call n8n workflows as tools.
- n8n Instance MCP can expose workflows and workflow inspection through n8n's MCP server.
- n8n MCP Trigger workflows can expose curated MCP tool sets.

Configure provider credentials inside n8n for n8n workflows. Batshit does not copy provider API keys into n8n.

## Docker URLs for tools

Docker has more than one "localhost" — use the URL that matches the *caller* (browser, app container, batshit-server, n8n, host service, or sidecar). If a tool URL works in your browser but fails inside a Docker agent run, it's probably using a browser URL where a container URL is needed. The full caller table lives in [Ports and URLs](../reference/ports-and-urls.md).

## Safety rules

Tools are powerful — treat them like giving a capable assistant access to real buttons. Recommended habits:

- Enable only the tool families an agent actually needs.
- Enable only Skills you trust and want that agent to use when a matching request comes up.
- Prefer sandboxed command execution for normal agent work.
- Be careful with tools that can write files, start services, send webhooks, or publish Artifacts.
- Don't import untrusted MCP gateways, Skills, CLI tools, n8n workflows, or Artifacts.
- Treat saved keys and tokens as sensitive.
- Review tool results in Execution Viewer when behavior surprises you.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Agent can't find an MCP tool | Tool Grid discoverability is off, or the gateway is offline. | Agent Tools settings and gateway status. |
| Docker MCP calls fail with unauthorized errors | Gateway token mismatch, or the gateway wasn't started with the same token. | Docker MCP Gateway settings and active environment. |
| CLI Tool is visible but fails | Manifest input, working directory, missing executable, or missing saved key. | Run the CLI Tool test path. |
| n8n tool callback fails | The Batshit Tools node isn't forwarding the per-message native-tool token, or the callback URL isn't reachable from n8n. | The `x-batshit-native-tool-token` header, n8n execution history, and runtime URLs. |
| Agent starts inventing setup commands | The add-on is connect-existing or deferred, not startable. | Runtime add-on status/prepare result. |

## Related docs

- [Primary Agents](../primary-agents/overview.md)
- [Subagents](../subagents/overview.md)
- [Artifacts](../artifacts/overview.md)
- [Execution Viewer](../chat/execution-viewer.md)
- [Security and trust](../security/overview.md)
