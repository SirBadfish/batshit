# Artifacts and Fabric

This is the architecture that makes people call Batshit an AI-managed frontend: a published Artifact stops being just a widget a person clicks and becomes a capability the agent can find and operate. This page explains that bridge — how a UI thing turns into an agent-usable tool, why the two faces are kept deliberately separate, and how Batshit keeps the whole arrangement safe. It assumes you've already met Artifacts and Fabric on their feature pages; this is the deeper "why and how."

## The core idea: from clickable widget to agent-operable capability

An Artifact starts life as a UI surface a person uses. You open it, you fill in fields, you click a button, you read the result. That's the whole story for plenty of Artifacts, and it's a fine place to stop.

But Batshit can take one more step. When you publish an Artifact *for agent use* — declaring what an agent is allowed to set when it calls it — Batshit registers that Artifact as a capability the agent can discover and run on its own. The widget you click and the tool an agent invokes become the same underlying thing, reached two different ways. Unpublish it, or turn agent use back off, and Batshit de-registers the capability cleanly, so the agent stops seeing it.

That bridge — UI thing becoming agent-usable capability, and back again — is the heart of what's going on here. It's what lets you say "build me a dashboard and publish it so the other agents can run it" and have it actually happen, instead of you wiring every step by hand. The hands-on steps for building and publishing live in [Artifacts](../artifacts/overview.md) and [Artifacts and agent use](../artifacts/agent-use.md); this page is about the architecture underneath them.

## The two faces of one Artifact

The user-clickable interface and the agent-usable runtime capability are intentionally distinct, even though they point at the same Artifact.

- **You** open the Artifact and operate it by hand — typing, toggling, clicking, reading the output on screen.
- **An agent** never touches that interface. It invokes the same Artifact as a tool: it discovers the capability, hands over typed values, and gets a structured result back.

Keeping these separate is the whole reason an agent can use an Artifact reliably. A human can muddle through an ambiguous form; a model needs a clear contract. So an agent-usable Artifact has to declare exactly what it accepts — typed fields the agent can set safely (text, a dropdown, a number, a toggle, and so on), or a run-only trigger when the Artifact just needs to be fired with no inputs. That declaration is the difference between "an agent can reason about how to call this" and "an agent is guessing at a UI it can't see."

This is also why Batshit won't quietly turn just any panel into an agent tool. An Artifact that only makes sense as a hands-on panel — an embedded third-party app, for example — stays a panel; running it as an agent tool needs a backend path and a real capability contract, not a screen scrape. The feature pages spell out which power sources qualify.

## Fabric: the capability layer

Fabric is how Batshit's own capabilities — and your published Artifacts — get exposed to agents as a registry the agent *searches and uses*, rather than a fixed menu wired in by hand.

The mechanism is the same discover-on-demand pattern Batshit uses everywhere else, and it matters for the same reason. Instead of describing every capability in every request, Batshit keeps the request small and lets the agent look things up when it actually needs them: it searches the registry for the capability that fits what it's trying to do, then calls the one exact match. A published Artifact shows up in that search as a runtime capability the agent can run; Batshit-native actions (building and managing Artifacts, voice engine controls, and the like) show up as their own capabilities. For the full reasoning on why this keeps prompts cheap and prevents a giant tool catalog from sabotaging caching, see [Tools without prompt bloat](tools-without-bloat.md).

Crucially, Batshit's own capabilities live in their own lane. You don't have to stand up some Batshit-owned external connector just to let an agent operate core Batshit features — Fabric handles that natively, kept apart from the user-installed tools you bring in. [What is Fabric?](../fabric/overview.md) covers that lane model in full.

## Why this is powerful — and how Batshit keeps it safe

The payoff is real: the agent can manage parts of the frontend for you — build an Artifact, publish it, run a capability — instead of you clicking through every step while it watches. That's a different posture from a chat app that can only talk back, and power like that only works if it's trustworthy. So Batshit gates it rather than handing agents a blank check.

- **Actions are risk-gated.** Reading or drafting is treated as low-stakes and runs directly. Anything that executes something or changes real state asks for explicit approval first. Some actions are restricted outright unless policy allows them. You don't have to memorize which is which — Batshit stops and asks when the stakes call for it, instead of acting first and hoping.
- **Visibility is scoped.** A published Artifact is only discoverable by the agents you've allowed. (One sharp edge worth knowing: turning agent use on but selecting *no* agents means the Artifact is visible to *nobody*, not everybody. The feature page calls this out because it's an easy way to confuse yourself.)
- **De-registration is clean.** When you unpublish or revoke agent use, the capability goes away. Agents don't keep discovering dead tools that fail when called — the registry reflects what's actually live right now.
- **Failures are honest.** If a capability can't run — missing a model, missing a webhook, missing permission — you get a clear error, not a quiet success that didn't actually do anything. Batshit would rather fail loudly than fake it.

The honest version of the trust model: agents can do a lot to the app, on purpose, but only within capabilities you've published, scoped to agents you've allowed, with heavier actions held back for your approval and clean removal when you change your mind. For the broader picture on Fabric's permissions, approval flow, and audit behavior, see [What is Fabric?](../fabric/overview.md).

## Related

- [Artifacts](../artifacts/overview.md) · [Artifacts and agent use](../artifacts/agent-use.md)
- [What is Fabric?](../fabric/overview.md)
- [Tools without prompt bloat](tools-without-bloat.md)
- [Context, caching, and token optimization](context-caching-tokens.md)
