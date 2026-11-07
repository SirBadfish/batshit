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

With [App Actions](../fabric/app-actions.md#connect-an-mcp-source-during-a-task), a permitted Primary Agent can configure supported custom HTTP or already-installed local STDIO sources during your task, then discover and use the actual returned tools. Setup permission does not approve later tool effects.

An MCP gateway is a source of MCP tools. Batshit works with several gateway types:

- Docker MCP Gateway.
- n8n MCP Trigger gateways.
- n8n Instance MCP.
- Custom streamable HTTP gateways.
- STDIO gateways launched from an explicit command.

Each gateway can expose many tools, and you rarely want every tool dumped into every prompt. So Batshit exposes MCP tools through Dynamic Tool Search: the agent gets a compact discovery path for capabilities beyond the tools already in its tool list.

The agent uses its saved gateway selection unless you choose a different set in the chat bar for that send. You can add gateways there; the agent cannot add gateways to its own access through a tool call. Approval resumes keep the original selection, and built-in Workers inherit the starting reply's selection.

## Dynamic Tool Search and Use

Dynamic Tool Search is an on-demand pattern:

1. **Call listed tools directly** — if the needed tool is already in the agent's tool list, the agent calls it without searching.
2. **Use an exact capability hint directly** — if Agent Setup and its current change notes provide an exact ref and enough input hints, the agent can call that ref without repeating the search.
3. **Search when needed** — otherwise, the agent searches discoverable capabilities by query, family, group, or exact name, then calls the selected result.

Search results are labeled by family so the agent knows what it found:

- `mcp:` for MCP gateway tools.
- `cli:` for saved CLI Tools.
- `artifact:` for published Artifact runtime tools.
- `fabric:` for Batshit-native controls.
- `batshit:` for Batshit utilities.
- `agent_browser:` for Agent Browser capabilities, where that runtime supports them.

The key habit is exactness: the agent uses the exact ref that Batshit provided, whether it came from a search result or Agent Setup and its current change notes. If Batshit provides `mcp:github.search_issues` or `artifact:use.artifact.storyboard`, the use step calls that exact ref with the required input. The backend validates every call, so compact schema hints help the agent but don't replace permissions or safety checks.

Why it works this way:

- Prompts stay smaller.
- You can install many MCP tools, CLI Tools, and published runtime tools without overwhelming every agent.
- Each agent can have a different discoverability scope.
- Compact schema hints let the agent use known tools directly; Tool Search supplies more detail when needed.

If an agent can't find a tool, check the Tool Grid and gateway health before assuming the tool doesn't exist.

Agents use Tool Use for Batshit Web Search, Workers, enabled Skill documentation and assigned Subagent calls. Existing switches, access and limits still apply. Skill scripts keep their Work Mode approval path.

Use **Preview Agent Setup Tools** in an agent’s Tool Grid to inspect the tool portion and estimated tokens. The enabled Skills catalog is outside this preview. [Dynamic Schema Hints](../admin/overview.md#dynamic-schema-hints) controls detail and the scalable-tool budget; changing hint size never grants tool access.

## The Tool Grid

The Tool Grid is the main control surface for agent tool access and Zip behavior. Depending on where you open it, it controls:

- Global defaults.
- Primary Agent defaults.
- Subagent defaults.
- Chatbar overrides for the current conversation.
- Skill-specific tool scope.
- Group tool sharing.

Common controls:

- **Enable** — the applicable native-tool or discovery choice for that row. Native grants and MCP/CLI discoverability retain their own meaning.
- **Display detail** — how much tool information appears in the dynamic context shown to the agent.
- **Zip buffer** — how many previous agent/assistant responses stay expanded for model context. It doesn't count user messages or each tool call separately.
- **Zip threshold** — minimum token size before `Normal` behavior may zip content. Most defaults use `0`.
- **Zip behavior** — `Inherited` follows the parent/default when there's a real one to inherit from, `Normal` uses buffer and threshold, `Auto` zips immediately by default, and `Off` keeps output open unless a Cool Tool result reaches the 25,000-token size guard.
- Default and inherited values appear as quiet placeholder text; a typed-looking value means that row is overriding its parent/default.
- **Batshit Tools** holds the built-in first-party lanes: file tools, Bash, Web Search, Fetch Zip, Subagent Call, Dynamic Tool Search, Artifact Tools, Fabric & Utilities, and Agent Browser Actions.
- CLI Tools and each MCP Source appear as their own top-level rows below Batshit Tools.
- Other tool handling sits at the bottom, usually as the single All Other Tools row.
- Group header rows (Batshit Tools, CLI Tools, MCP) can apply Zip Buffer and Zip Threshold to every child row underneath; individual rows can override their own details where the UI shows a per-tool control.
- **Tool Notes**, on by default and marked **Recommended**, because notes keep the facts the agent needs in view after the full result is compressed, so it reads files again less. (The old **Zip Control Permissions** setting is parked: Hold and release replaced it, so it no longer appears and stays off.)

The Global Tool Grid has `Reset to defaults`. The Agent Tool Grid has `Reset to global settings`, which clears the agent's own Tool Grid and Zip overrides so it inherits global behavior again.

Keep tool access as narrow as the job allows. Broad access is powerful, but it also makes agent behavior harder to predict.

- **Typed File Tools** adds `read_file`, `write_file` and `edit_file` when Bash and the host allow them. It starts off and has its own Enable switch per agent. See [Typed file tools](#typed-file-tools).

- **Refreshed File Reads** starts on. Eligible open file reads show the file as it was when the reply started; reads that cannot refresh stay zipped for that reply. Saved per-agent and global choices remain in effect. See [Refreshed File Reads](zips.md#refreshed-file-reads).

### Bash access modes

- **Plan** allows inspection and search commands plus deliberate Markdown (`.md`) writes or edits. Batshit blocks command chaining, hidden mutation or command-execution flags, shell/process substitution, and pipelines that contain an executor or writer instead of another approved read-only stage. Git commands are blocked here because repository configuration can make even an inspection run helper programs. Use direct commands or managed `apply_patch` for Markdown edits; shell/interpreter wrappers are blocked, and every redirected output file must be Markdown.
- **Agent** allows workspace work. Simple inspections normally skip a popup. In an agent chat, shell file writes, Git commands, interpreters, and ambiguous compound commands follow the agent's **Approval Policy** unless explicitly allowlisted: **On Failure** asks you first, and **Never** refuses them. Managed patches, and the typed file tools when they are on, create and edit files without a card. Every operation must qualify independently. Batshit's managed patch and native file tools keep their normal workspace checks. When an agent sends a patch together with a command to run after it, such as a test, Batshit asks once for both. The card names the patched files and the first command. The command runs only after the whole patch applied, and if you deny the card, neither runs. Where no card can appear (a group chat, or approval cards turned off), Batshit writes nothing for such a call, and the agent sends the patch and the command separately.
- **Dangerous** skips approval popups, while Batshit's hard safety blocks and your Always Block rules still apply.

**On the Claude plan, commands go through Batshit's Bash.** Claude Code's own tools are off there, so an agent or Subagent on the Claude plan connection runs its commands through Batshit's Bash tool, under the modes, the Sandbox choice, the allow list, the Always Block list and Batshit's guard on its own source code. The removed Claude Code CLI lanes had a shell of their own outside all of these.

**An approved command runs once.** If the reply fails or you press **Stop** after you approved, the card still says **Approved** and does not offer the buttons again. To run the command again, ask the agent again; it asks you again with a new card.

**What you typed while it waited, waits too.** A steer or a queued message the agent did not get to before the card waits for your click, and the agent answers it when the reply you approved (or denied) finishes; a card that expired does not release it. See [When the reply stops at an approval card](../chat/overview.md#when-the-reply-stops-at-an-approval-card).

Local Bash commands use an installed system zsh, or bash when zsh is unavailable. The tool card records the shell that ran the command. If neither shell is installed, Batshit explains what is missing. A failed command is never repeated in another shell. Managed `apply_patch` edits run inside Batshit and do not need either shell. Batshit reads and writes a patch only inside the workspace folder, even when the agent's commands run in a sandbox: if a folder in a patched path turns into a link while the patch runs, or the path leads onto another disk, the patch stops. Batshit then puts back what the patch had already changed, and names any file it could not put back. A patch can read or write files up to 64 MB each. A command written after a patch, such as a test, runs in the shell like any other command, and only when the whole patch applied.

### Typed file tools

An agent can also get three file tools beside Bash: `read_file`, `write_file` and `edit_file`. They do the file work an agent does most (read a file, write a whole file, change part of a file) without a shell command, so each call shows a clean file card and its result is easy for the agent to follow.

- **`read_file`** reads a text file in the project, whole or as a line range. The result says which lines it shows and how many lines the file has. A very large file is cut at about 90,000 characters, and the result says so.
- **`write_file`** creates or replaces a whole text file. The file is replaced in one step: it is either fully written or not changed.
- **`edit_file`** changes part of a file by exact replacement. Each piece of old text must match the file exactly once, and all the changes in one call apply together or not at all. If a piece matches twice or not at all, nothing is written and the agent is told why. Its immediate success reply is concise; the full diff stays in the saved card and Zip. An agent can make several independent file calls in one batch; each file is a separate operation.

They follow the same rules as a file patch in Bash: they work only inside the project folder, Plan mode lets them write only Markdown (`.md`) files, and Batshit's guard on its own source code still applies. They never show an approval card, the same as a file patch. They refuse a symbolic link at the file itself and preserve ordinary permission bits when replacing a file. If a call loses confirmation during a write, its result says the outcome is uncertain; any temporary files that could not be safely removed are named.

**Turning them on.** They start off. Open **Settings → Agents → the agent → Tools**, expand **Batshit Tools**, and turn on **Typed File Tools** in the Enable column. The same agent Tool Grid is available from the chat bar. An agent gets them only when:

- its **Bash Tool** is on, and
- its **Sandbox Level** and host support them: **Local machine** on a supported native Mac or Linux installation, or **Apple Container** / **Docker Sandbox** on Mac. In the Docker app, **Local machine** works inside the app container's workspace; **Docker Sandbox** also needs the normal host operator on Mac and a real shared host folder. A private Docker workspace volume works with Local, but cannot be shared with host Sandbox. Windows and native Linux sandbox locations are not qualified yet. The setting shows the reason when the tools are unavailable; saved setup does not mean a runtime is ready.

**Known Mac shared-folder limitation.** With Batshit running inside Docker Desktop on Mac, a hard-linked file in a shared host folder can be read but an edit may be refused. A hard link means two filenames refer to the same underlying file. When Batshit cannot verify that file, it reports the refusal and leaves the contents of both files intact. This limitation is still open for a future fix.

A Subagent has its own choice in its Tools tab, and it also needs its parent agent to allow them.

**The Always Block List covers them.** The Always Block List also covers the typed file tools: a rule whose first word names apply_patch, write_file or edit_file blocks every write_file and edit_file call, and one naming read_file blocks read_file. Wildcards count, so apply_patch* names the two writers and * names all three. The rest of the rule is not read as a file path.

**Zips.** Their results use the **Read File**, **Write File** and **Edit File** rows of the Tool Grid. Those rows set zip behavior only; they do not turn the tools on or off. When the agent reads a whole file again or edits it, the older copy of that file compresses on the agent's next reply, the same as for a read in Bash.

### Fabric & Utilities and Artifact Tools

Both rows sit under **Batshit Tools**. An agent's **Enable** switches control whether it may use those capabilities; a hint or Display Detail choice does not grant access.

**Fabric & Utilities** covers Batshit's app controls and enabled utilities. It includes a compact family/count hint plus fixed guidance for features the agent can use. There is no separate display/hide setting for this row. Agent DMs, schedules, Whiteboard and the judgment tool keep their own settings and dependencies. Broad Fabric app management stays Primary-only; a Subagent's switch is unavailable with an explanation.

**Artifact Tools** is separate. Its Enable switch controls execution access, while **Display Detail** controls how much information the agent sees about accessible published runtime tools. Artifact allowlists and runtime validation still apply. A visible panel is not automatically an agent tool.

The **Global Tool Grid** sets shared display and compression defaults. The **Agent Tool Grid** and chat-bar Tools menu add applicable Enable switches. **Reset to global settings** clears display and Zip overrides; it does not silently turn on a native tool or change an explicitly saved Typed File Tools choice. Read, Write, Edit, Search and List rows own compression rather than having their own enable switches.

## Skills and Prompts

Skills are reusable instruction bundles with optional reference files and scripts. They differ from CLI Tools: a Skill teaches an agent a *workflow*, while a CLI Tool *runs* a saved command or executable.

You can invoke a Skill explicitly with its slash command, but that's not the only path. When a Skill is enabled for an agent, that agent may load and use it on its own when your request clearly matches the Skill's purpose. In other words, enabling a Skill is permission for the agent to use it — not a promise it stays dormant until you type the slash command.

Keep enabled Skills trusted and relevant to that agent. Batshit uses its normal skill-loading path, and normal tool, saved-key, and sandbox boundaries still apply to anything the Skill tells the agent to do.

## Portable Skills

Portable Skills are the outside-agent version of Batshit system skills. Instead of running inside a Batshit chat, they are installed into an agent you already use, such as Claude Code, Codex, or another coding assistant.

They call your local Batshit instance through the app API with a Portable Skill Token from Settings → Plugins & shit → Portable Skills. That token is scoped by family, such as Voice Engines, Artifacts, CLI Tools, Skills, or Goon Scenes.

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

Use CLI Tools for a repeatable local action that agents should call safely and consistently. Stop cancels a saved CLI tool running in that reply; on Mac and Linux, Stop and timeout also end the processes it started.

An agent can find and run only the CLI Tools saved for it. An agent with no saved CLI Tool selection uses the CLI Tools your Tool Grid makes discoverable, and a Subagent uses its own selection. A tool call can ask for fewer CLI Tools, never for one outside that list.

Most CLI Tool setup is best handled through an agent or the CLI Tool Creator flow, because the record includes command shape, validation, permissions, and runtime boundaries. Settings still shows the saved details and user-facing controls — icon, status, tests, permissions — but normal users shouldn't need to hand-author raw manifests.

Good examples:

- Run a repo-specific formatter.
- Convert a file through a known local script.
- Query a local helper with fixed arguments.
- Call a trusted internal command with a narrow input schema.

Avoid CLI Tools for vague, open-ended shell access. If the agent needs general command work, use Batshit's Bash tool with the appropriate sandbox/back-end setting.

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

Runtime add-ons are optional services Batshit can connect to, start through an approved operator, or guide you to start manually.

Manage an add-on through the Primary Agent's matching Batshit control and the required approval. Subagents and Workers do not receive broad runtime-management access. Keep n8n and external runtime administration under their documented controls.

Current Docker add-on shapes:

- Startable sidecar/worker/profile entries such as Cloudflared, FBX-to-VRMA, Agent Browser, LiveKit, and `comfyui-validation`.
- Connect-existing entries such as real ComfyUI/Gradio-style services, Local AI runtimes, and voice engines.
- Deferred entries that should fail clearly instead of pretending to work.

The Docker core app container does not get arbitrary host Docker control. Start/stop actions go through Batshit-approved add-on IDs and an authenticated host operator when that path is configured.

## How tools reach an agent

Every Primary Agent uses Batshit native tools, on any model connection. On the Claude plan connection, Claude Code's own tools are turned off and the model sees only the Batshit tools you allow.


If a tool works for one agent and not another, check that it's enabled for that agent and that the runtime path is configured.

## Agent Browser

Agent Browser is Batshit's browser automation runtime.

Mac app Batshit can use the host Agent Browser path where configured. Docker Batshit uses an optional `agent-browser` sidecar/controller that runs its own headless Chromium — it does not use your host Chrome profile, cookies, or visible browser window.

When an agent takes a screenshot, a vision-capable model sees it during the same reply on every supported API provider. Providers that can carry an image inside a tool result get it there; providers whose tool results are text-only get the screenshot as a follow-up image input within the same reply. A model that cannot take images gets a clear note instead of a wall of image bytes. Screenshot bytes are never kept in chat history.

In Docker, raw app-container Bash commands like `agent-browser ...` are blocked. Use Batshit's Agent Browser tools/settings so the request routes through the sidecar.

## n8n tools

n8n can participate in several ways:

- Primary Agents can call n8n workflows as tools.
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
| A tool you just added on the server doesn't show up yet | Batshit keeps each gateway's tool list for up to five minutes, so messages don't wait on every tool server. | Click **Refresh** on that gateway in Settings → MCPs, or wait five minutes. |
| Docker MCP calls fail with unauthorized errors | Gateway token mismatch, or the gateway wasn't started with the same token. | Docker MCP Gateway settings and active environment. |
| CLI Tool is visible but fails | Manifest input, working directory, missing executable, or missing saved key. | Run the CLI Tool test path. |
| Agent starts inventing setup commands | The add-on is connect-existing or deferred, not startable. | Runtime add-on status/prepare result. |

## App Actions in Fabric & Utilities

App Actions use the enabled Fabric & Utilities family with their own explicitly saved access. They support current-view operations and scoped Settings changes at the limits in [App Actions](../fabric/app-actions.md). Tool enablement does not replace protected-category policy, exact review or native/file permissions. [Fabric](../fabric/overview.md#asking-an-agent-to-use-the-current-view) explains current tabs and unsaved edits.

## Related docs

- [Primary Agents](../primary-agents/overview.md)
- [Subagents](../subagents/overview.md)
- [Artifacts](../artifacts/overview.md)
- [Execution Viewer](../chat/execution-viewer.md)
- [Security and trust](../security/overview.md)
