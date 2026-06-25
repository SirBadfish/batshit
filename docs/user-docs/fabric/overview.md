# What is Fabric?

Fabric is how Batshit gives agents safe, on-demand control over the app itself. The same agent you're chatting with can search a registry of Batshit-native capabilities and use them — so it can build an Artifact, publish it, adjust a voice engine, or check a runtime add-on without you walking through every step by hand. That's what people mean when they call Batshit an AI-managed frontend: the agent and the app are wired together on purpose, behind a clean and simple UI.

## The problem Fabric solves

Most AI chat apps are one-directional. The agent can talk to you and maybe call a few external tools, but it can't actually operate the app it lives in. If you want to create something, configure something, or publish something, *you* click through the settings while the agent watches.

Batshit takes the opposite stance. A lot of what Batshit can do — Artifacts, Skills, voice engines, runtime add-ons, CLI Tools — is stuff an agent could handle for you if it had a safe way to reach those capabilities. Fabric is that safe way. It's a registry of Batshit-native actions the agent can discover and run, with permissions and safety checks built into every call.

The result: the agent manages the fiddly parts for you, and the visible app stays calm and uncluttered instead of drowning you in buttons.

## The four lanes (the key mental model)

This is the part worth internalizing. Batshit deliberately keeps four different kinds of capability in **separate lanes**, and Fabric is only one of them:

- **Fabric** — Batshit's *own* app capabilities. Building and managing Artifacts, voice engine controls, runtime add-on actions, CLI Tool authoring, and similar Batshit-native actions live here.
- **MCP gateways** — *user-installed* MCP tools. These come from MCP servers you connect (Docker MCP, n8n MCP, custom HTTP, and so on). They're external ecosystems you bring in, not part of Batshit's core.
- **CLI Tools** — *user-added* local commands and scripts, saved as proper tool records with structured inputs and boundaries.
- **Published Artifacts** — an Artifact you publish can become an agent-usable runtime tool that agents call with typed inputs.

Keeping these apart is intentional, and it pays off:

- **Cleaner** — you always know whether a capability is Batshit's, yours-via-MCP, your own script, or a published Artifact.
- **Safer** — Batshit-native control doesn't get tangled up with whatever external tools you've installed.
- **More token-efficient** — capabilities are discovered on demand instead of being stuffed into every single request.
- **More scalable** — you can install hundreds of MCP tools and CLI Tools without overwhelming every agent, because nothing is loaded until it's actually needed.

You don't have to set up a Batshit-owned MCP gateway just to let agents use core Batshit features. Fabric handles that lane on its own.

## How it feels in use

You won't usually "open Fabric" anywhere — it's the plumbing, not a panel. What you notice is that you can ask an agent to *do* things to the app and it can follow through. "Build me a dashboard Artifact and publish it." "Set this Artifact up so other agents can run it." "Register this local voice engine." The agent finds the right capability and runs it, then reports back like any other tool result.

Under the hood, the agent searches the registry for the capability it needs, then calls the exact one. It only pulls in what's relevant to your request, which is why prompts stay small even though Batshit can do a lot.

## Safety and trust

Fabric actions are **risk-gated**, so the agent can't quietly do something heavy without the right clearance:

- **Safe** actions (like reading a model catalog or creating a draft Artifact) run directly.
- **Confirm** actions (the ones that execute something or change real state) ask for explicit approval before they run.
- **Restricted** actions are blocked unless policy explicitly allows them.

Every Fabric action is also validated against what the agent is actually permitted to do, and executions are recorded. Honest boundaries are the whole point — Batshit fails clearly instead of pretending an action succeeded. For the bigger picture on agent permissions, sandboxing, and trust, see [Security and trust](../security/overview.md).

## Where Fabric shows up

Fabric is the foundation under several features you'll meet elsewhere:

- **Tools** — Fabric is the Batshit-native lane alongside MCP gateways, CLI Tools, and Artifact runtime tools. See [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md) for how all the lanes fit together and how agents discover them.
- **Artifacts** — agents build, manage, and publish Artifacts through Fabric, and a published Artifact can become an agent-usable runtime tool. See [Artifacts and agent use](../artifacts/agent-use.md).
- **Voice** — voice engine controls (registering and managing speech engines) are Fabric capabilities. See [Voice](../voice/overview.md).
- **Skills** — Skills and Skill authoring are exposed through Fabric capabilities too, so agents can load and manage them when a request fits.

## Related docs

- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Artifacts and agent use](../artifacts/agent-use.md)
- [Primary Agents](../primary-agents/overview.md)
- [Voice](../voice/overview.md)
- [Security and trust](../security/overview.md)
