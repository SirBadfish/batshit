# Subagents

A Subagent is a smaller assistant a Primary Agent can call when it needs specialized help. You still talk to the Primary Agent. It decides when to call a Subagent, hands it a task, receives the result, and continues the conversation.

Think of Subagents as teammates the Primary Agent delegates to, not as general MCP tools. They show up internally as tool calls, but the idea is still "an assistant called by another assistant."

## Subagent types

Batshit has four launch-facing Subagent types:

| Type | What it means | Can be assigned to |
| --- | --- | --- |
| `n8n Subnode Subagent` | An AI Agent Tool node attached inside an n8n Primary Agent workflow. | `n8n` Primary Agents only. |
| `n8n Workflow Subagent` | A separate n8n workflow with its own webhook, called like a specialist. | `API` and `CLI` Primary Agents. |
| `API Subagent` | A Batshit-managed direct-provider specialist run. | `API` and `CLI` Primary Agents. |
| `CLI Subagent` | A Batshit-managed one-shot Codex or Claude Code specialist run. | `API` and `CLI` Primary Agents. |

Pairing matters. If a Subagent doesn't show up for a Primary Agent, the most common reason is that the pair isn't supported.

## Pairing matrix

| Primary Agent type | Supported Subagent types |
| --- | --- |
| `n8n` | `n8n Subnode Subagents` |
| `API` | `n8n Workflow Subagents`, `API Subagents`, `CLI Subagents` |
| `CLI` | `n8n Workflow Subagents`, `API Subagents`, `CLI Subagents` |

## When to use a Subagent

Use a Subagent when a recurring piece of work deserves its own instructions, model, tools, or personality. Good fits:

- A research specialist.
- A code reviewer.
- A document drafter.
- An n8n workflow analyst.
- A creative brainstorming partner.
- A data extractor.
- A tool-heavy helper with narrower permissions than the Primary Agent.

Don't reach for a Subagent just because a task is one sentence long. For small one-off work, a normal Primary Agent reply is simpler.

## How a Subagent differs from a tool

A tool performs a specific action: run a command, search a gateway, call a workflow, read a Zip, generate an Artifact result.

A Subagent *thinks and responds* as an assistant. It can have its own name, description, system prompt, model settings, tool discoverability, avatar, and — when the backing runtime supports it — saved memory. The Primary Agent sees Subagents as callable helpers and picks the one that fits your request.

## What the Primary Agent sends

When a Primary Agent calls a Subagent, Batshit gives it enough context to do the delegated job. The transport depends on the Subagent type, but the launch contract is the same:

- The Subagent receives its base instructions.
- It receives its user-authored system prompt.
- It may receive the global user prompt, if that setting is enabled for it.
- It receives the active Project path from the parent conversation.
- It uses its own tool settings, not the parent agent's full Tool Grid.

That last point matters: Subagents inherit the parent Project path, but they do not automatically inherit every tool, MCP gateway, CLI tool, or display setting from the Primary Agent. This keeps specialist permissions easy to reason about.

## Tool scope

Each Subagent can have its own Tool Grid settings. Depending on type and configuration, launch-facing Subagents can use families such as:

- Dynamic Tool Search/Use for assigned discovery families (MCP tools, saved CLI Tools, Agent Browser capabilities, published Artifact runtime tools).
- Web Search.
- Bash or sandbox-backed command execution, where supported.
- Assigned Skills and Prompts.
- Approved runtime add-on actions.

Broad Batshit control-plane tools stay Primary Agent territory. Managed Subagents can use published Artifact runtime tools, but they don't get broad Fabric controls for changing the whole app.

Some helper actions are intentionally Primary-only. Fetch Zip (`batshit_tool_use` with ref `fabric:sys.zip.fetch`) is available to `n8n` Primary Agents when enabled, but Subagents are blocked from using it directly.

## Non-streaming behavior

Subagent runs are tool-like and non-streaming for launch. The Primary Agent waits for the Subagent's result, then continues the visible response. So:

- You usually see a Subagent call card or summarized tool result, not a live character-by-character Subagent stream.
- The Primary Agent stays responsible for the final answer.
- A Subagent can do focused work without taking over the chat.

## n8n Subnode Subagents

Use `n8n Subnode Subagents` when your main agent is an `n8n` Primary Agent. This type lives inside the n8n Primary Agent workflow as an AI Agent Tool node. Batshit manages the Subagent definition, and the workflow uses the Subagent prompt data Batshit sends in the webhook payload.

Reach for it when:

- Your main assistant is already an n8n workflow.
- You want subagent behavior inside the visual n8n graph.
- You're comfortable wiring AI Agent Tool nodes in n8n.

## n8n Workflow Subagents

Use `n8n Workflow Subagents` when an `API` or `CLI` Primary Agent should call a separate n8n workflow as a specialist. This isn't a Primary Agent workflow — it's a tool-like workflow with its own webhook, called when the Subagent description matches the task.

Reach for it when:

- The specialist logic belongs in n8n.
- The specialist needs n8n credentials or nodes.
- You want visual workflow history for the specialist.

## API Subagents

Use `API Subagents` to run a direct-provider specialist without building another n8n workflow. This is a good default for lightweight research, writing, review, and analysis specialists, with its own model choice and tool discoverability.

Reach for it when:

- You want fast, direct setup.
- You want provider keys managed in Batshit.
- You want a specialist with narrower tools than the Primary Agent.

## CLI Subagents

Use `CLI Subagents` when the specialist should use a managed CLI lane for a one-shot task. This is useful for coding, repo inspection, and CLI-native reasoning, but it's deliberately non-interactive — configure it so it can finish the job without asking the user for approval mid-run.

Reach for it when:

- The specialist needs CLI-native project behavior.
- The delegated task is code-heavy.
- You want a strong one-shot helper while the Primary Agent keeps owning the conversation.

Docker note: CLI Subagents need the CLI authenticated in the Docker app container, just like CLI Primary Agents.

## Setup checklist

1. Create the Subagent in Settings.
2. Pick the correct Subagent type.
3. Give it a short, specific description — the Primary Agent uses this to decide when to call it.
4. Add the Subagent's system prompt.
5. Choose model/runtime settings if it should differ from the Primary Agent.
6. Configure its Tool Grid if it needs MCP gateways, saved CLI tools, Artifacts, or Skills.
7. Assign it to compatible Primary Agents.
8. Send a test request that clearly asks for that specialist.

Good Subagent descriptions are specific:

- "Reviews TypeScript and Svelte changes for bugs, regressions, missing tests, and launch-readiness risk."
- "Summarizes long n8n workflows and explains each branch in plain English."
- "Drafts user-facing documentation in warm, non-technical language."

Vague ones aren't:

- "Helpful assistant."
- "Does stuff."
- "Smart helper."

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Subagent doesn't appear for an agent | Unsupported pairing. | The pairing matrix above. |
| Primary Agent never calls it | The description is too vague or off-topic for the request. | Rewrite the Subagent description as a clear specialty. |
| Subagent can't use a tool | Its Tool Grid doesn't enable that tool. | The Subagent's Tools settings. |
| n8n Workflow Subagent fails | Webhook, scoped native-tool auth, or n8n credentials aren't configured. | n8n execution history, the `x-batshit-native-tool-token` header, and n8n credential setup. |
| CLI Subagent fails with login/auth errors | The CLI isn't authenticated where Batshit runs it. | For Docker, authenticate inside the app container. |

## Related docs

- [Primary Agents](../primary-agents/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Security and trust](../security/overview.md)
