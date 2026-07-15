# Tools without prompt bloat

Batshit can reach a huge number of tools without dragging their schemas into every request. Instead of describing every enabled tool on every send, it keeps a tiny, stable set of native tools always present and lets the agent discover everything else on demand. This page explains why that matters and how the mechanism works. For what each tool type *is* and how to turn it on, see [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md) and [What is Fabric?](../fabric/overview.md).

## The problem: every tool costs tokens on every turn

A model has no memory between calls. Each turn re-sends the whole request, and that request normally includes a full description — a JSON schema of name, purpose, and every input field — for each tool the agent is allowed to use. One or two tools is nothing. But people don't stop at two. Connect a few MCP servers, save some CLI Tools, publish a handful of Artifacts, and you can be staring at dozens or hundreds of tool definitions riding along on *every single message* whether the agent needs them or not.

That's expensive in two ways, and the second one is sneakier than the first:

- **Raw token cost.** A large tool catalog can be thousands of tokens of pure schema, re-sent on every turn for the life of the conversation. You pay for it constantly even when no tool gets called.
- **Attention clutter.** A model has to read past everything you hand it. Bury the relevant tool inside a wall of irrelevant ones and the agent is more likely to pick the wrong tool, mangle the inputs, or get distracted from the actual task.

There's a third cost that ties directly into how Batshit saves money elsewhere. As [Context, caching, and token optimization](context-caching-tokens.md) explains, providers reward a *stable* prefix — if the front of your request is identical to last time, a caching provider can reuse that work cheaply. A giant tool catalog parked near the front of the request is exactly the kind of thing that shifts and churns as you install, remove, or re-scope tools. Every change reshuffles the front of the request and breaks what could have been reused. So a big static tool list doesn't just cost tokens directly — it quietly sabotages the caching that would have saved you tokens everywhere else.

## Batshit's answer: a small stable surface plus search-and-use

Batshit refuses to put the whole catalog in the request. The agent always sees a small, fixed set of native tools — the everyday primitives like running a command, web search, and a couple of others — and one extra capability: **the ability to search for everything else.**

The pattern is two steps:

1. **Search.** When the agent needs a capability it doesn't already have in hand, it searches Batshit's discoverable tools by what it's trying to do — a query, a family, or an exact name. Search returns a short list of matches with just enough of a hint to choose, not the full schema for everything.
2. **Use.** The agent picks one exact result and calls it. Only then does the precise input contract for that one tool come into play. The backend validates the call against the real schema, permissions, and safety rules regardless of what the hint said.

The effect is that the request carries a tiny, steady tool surface instead of a sprawling menu. The full description of a tool only enters the picture for the one tool the agent actually decided to use, in the turn it uses it. You can have hundreds of tools installed and the per-message tool overhead barely moves.

This is deliberate, and it's the opposite of "load everything just in case." Loading everything is simpler to build, but it taxes every message forever to save the agent a single search step it rarely needs.

## Why the lanes are kept separate

Discovery wouldn't be enough on its own if everything got dumped into one undifferentiated pile. Batshit keeps capabilities in **four separate lanes**, and search knows which lane each result came from:

- **Fabric** — Batshit's *own* app capabilities, like building and publishing an Artifact or managing a voice engine. See [What is Fabric?](../fabric/overview.md).
- **MCP gateways** — *user-installed* tools from MCP servers you connect.
- **CLI Tools** — *user-added* local commands and scripts, saved as proper tool records.
- **Published Artifacts** — an Artifact you publish can become a runtime tool agents call with typed inputs.

A single flat tool list would be worse on every axis that matters:

- **Token cost.** One pile means no clean way to scope discovery per agent. Lanes let one agent see only the families it should, so its searches stay cheap and focused.
- **Safety.** Batshit-native control of the app is a different kind of power than an external MCP server or a local script. Keeping them apart means a third-party tool can't quietly masquerade as a core Batshit action, and Batshit-native control is risk-gated on its own terms rather than blended in with whatever you've installed.
- **Clarity.** When a tool runs, you can always tell whether it was Batshit's, yours-via-MCP, your own script, or a published Artifact. That makes agent behavior far easier to reason about and to review afterward.
- **Scale.** Separate lanes are how Batshit lets you install a *lot* without overwhelming any single agent. Nothing in a lane loads until it's actually searched for, so the cost of having many capabilities available is close to zero until one gets used.

There's a practical bonus: you don't have to stand up a Batshit-owned MCP gateway just to let agents use core Batshit features. Fabric is its own lane, handled natively, so app control and external tooling never get tangled together.

## The payoff

Because the tool surface stays small and stable, two good things happen at once.

The obvious one is direct: you aren't paying for a tool catalog on turns that don't use it. The subtler one is the cache win. With the bulky, shifting catalog out of the request, the front of an `API` Primary Agent request stays steady from one send to the next — which is exactly the condition provider caching needs. So keeping tools out of the prefix doesn't just trim the tool cost itself; it protects the reusable prefix that saves tokens across the *whole* request. The two optimizations reinforce each other instead of fighting. For how that prefix and provider caching work, see [Context, caching, and token optimization](context-caching-tokens.md).

Cost goes down and clarity goes up, for the same structural reason: Batshit only brings a capability into the conversation at the moment it's needed, and never before.

## Related

- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md) · [What is Fabric?](../fabric/overview.md)
- [Context, caching, and token optimization](context-caching-tokens.md)
- [Zips and Clips under the hood](zips-and-clips.md)
- [Artifacts and Fabric](artifacts-and-fabric.md)
- [Execution Viewer](../chat/execution-viewer.md)
