# How Batshit works

Most of these docs explain features. This section explains the machinery underneath them — how Batshit assembles a prompt, why it compresses what it compresses, how tools reach a model without bloating every request, and where your data actually lives. You don't need any of this to use Batshit. It's here for the curious and for power users who want to understand why Batshit spends fewer tokens and behaves the way it does.

One theme runs through all of it: Batshit was designed around the cost-and-clarity problem from the start, not patched onto a chat UI afterward. Stable things stay stable so they can be reused, bulky things get compressed before a provider ever sees them, and Batshit shows you the evidence instead of asking you to trust it.

## In this section

- [Context, caching, and token optimization](context-caching-tokens.md) — how Batshit shapes a request so the stable parts stay reusable, and how provider caching builds on that.
- [Tools without prompt bloat](tools-without-bloat.md) — why Batshit doesn't stuff every tool schema into every request.
- [Zips and Clips under the hood](zips-and-clips.md) — the two views of a message, and how files and images stay out of prompt text.
- [Agents and runtime paths](agents-and-runtime-paths.md) — n8n, API, and CLI as different runtimes behind one experience.
- [Artifacts and Fabric](artifacts-and-fabric.md) — how a published Artifact becomes a capability an agent can operate.
- [Streaming, recovery, and transparency](streaming-and-recovery.md) — how live output, failure recovery, and the Execution Viewer fit together.
- [Local-first runtime boundaries](local-first-boundaries.md) — what runs where, and what stays on your machine.

Each page assumes you've already met the feature it explains, and links back to it. If a term is new, the feature page teaches it first; this section is the deeper "why and how".
