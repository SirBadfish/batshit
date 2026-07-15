# Artifacts

Artifacts are persistent mini-apps that live inside Batshit. They can be simple static widgets, AI-powered tools, n8n workflow front ends, ComfyUI-style panels, image generators, dashboards, forms, or other reusable workspace surfaces.

An Artifact is not just a message in chat. It's a saved interface you can open again.

This page is the mental model. For the hands-on setup — creating, publishing, and making an Artifact agent-usable — see [Artifacts and agent use](agent-use.md).

## What Artifacts are for

Reach for an Artifact when you want:

- A reusable tool instead of a one-time answer.
- A form or dashboard that stays available in the workspace.
- An AI-powered mini-app.
- A front end for an n8n workflow.
- A ComfyUI-style workflow panel.
- A way to share generated output back into chat.
- A polished interface an agent can build and later improve.

Examples: a task organizer, a workflow launcher, a prompt-to-image panel, a model comparison dashboard, a custom n8n webhook form, or a reusable writing assistant with saved fields.

## Where Artifacts appear

Artifacts can be published into workspace zones:

| Zone | What it feels like |
| --- | --- |
| Header | A small icon in the header that opens the Artifact in an overlay. |
| Panel | A right-rail widget beside the chat. |
| Trigger | A compact dropdown-style widget. |

The Artifact shell belongs to Batshit; the Artifact body should focus on controls, status, and results. Well-built Artifacts don't repeat their own title and description at the top of the iframe body unless you specifically need instructions there.

## How Artifacts are built

Artifact creation is skill-led. When you ask an agent to make or change an Artifact, it uses Batshit's Artifact Creator skill and the Artifact control tools:

1. You describe what you want.
2. The agent loads Artifact-building instructions.
3. The agent creates or updates the Artifact through Batshit controls.
4. Batshit validates the structure before saving.
5. You preview, publish, assign zones, and decide whether agents may use it.

Most users shouldn't hand-edit raw Artifact HTML unless they know exactly what they're doing. The Advanced Builder exists for power users and repair work.

## Artifact power sources

The Power Source describes what powers an Artifact, and whether an agent can run it:

| Power source | What it means | Agent-usable by default? |
| --- | --- | --- |
| Built-in AI | Batshit calls its direct AI path for the Artifact. | Can be, if published with a valid runtime contract. |
| n8n Workflow | The Artifact calls an n8n workflow webhook. | Can be, if the runtime contract is valid. |
| Custom Webhook | The Artifact calls a custom webhook you provide. | Can be, if the runtime contract is valid. |
| ComfyUI | A panel for a ComfyUI-style service through Batshit's proxy. | No — current ComfyUI panels are user-run, not agent tools. |
| HuggingFace | Embeds a HuggingFace Space. | No — user-only panel runtime. |
| Gradio | Embeds a standalone Gradio app. | No — user-only panel runtime. |
| Static / No AI | A UI-only widget. | No — no AI completion path. |

Don't force a panel runtime into an agent tool by changing its power source. If an agent needs to run the thing, build a backend-runnable Artifact or webhook path with typed fields.

## Built-in AI Artifacts

A Built-in AI Artifact uses Batshit's direct AI path. It can generate text, images, speech, or structured objects when the selected model/provider supports that output.

Batshit doesn't apply one global default model to every Artifact. A finished Built-in AI Artifact normally carries its own selected model, unless it's intentionally built to let the user choose a model at runtime. Builders should use Batshit's model catalog to find the exact model ID and runtime type — a broadly "visual" catalog entry might be an image, video, or 3D model, so an image generator needs an image-capable result.

The model is resolved from the Artifact's runtime contract: a request override if the runtime call provides one, otherwise the Artifact's saved model configuration. Batshit fails clearly if the requested model isn't configured — it doesn't silently fall back to an unrelated Primary Agent model or a global default, because swapping models changes behavior, cost, and whether intended-model failures stay visible. Direct image and speech provider paths use API keys saved in Batshit for the current instance; they don't rely on a hidden environment-key fallback.

## Artifact run logs

When an Artifact calls Batshit's runtime, Batshit keeps a short-lived, scrubbed run log for about two weeks. Agents can inspect recent runs to see the related chat message, a short scrubbed prompt preview, the selected model, runtime path, output counts, and sanitized errors. For image generators, a run with zero generated files is treated as a failure to fix, even if the Artifact saved or published correctly.

These logs never store API keys, auth tokens, or raw image/audio bytes. Deleting an Artifact deletes its run logs immediately; editing, rolling back, or deleting Artifact versions does not.

## Webhook and n8n Artifacts

Webhook-backed Artifacts call a saved webhook URL — n8n workflow Artifacts are the most common kind. Use them when the real work belongs in n8n: workflow branches, credentials, or third-party nodes, fronted by a friendly Artifact UI.

A couple of safety/URL notes: request-supplied webhook overrides are rejected (the Artifact uses its saved webhook URL), and in Docker a browser `localhost` URL may need to be called as `host.docker.internal` or `http://n8n:5678` depending on where n8n runs. See [Artifacts and agent use](agent-use.md) for setup steps.

## ComfyUI and external panels

ComfyUI-style Artifacts call ComfyUI-shaped endpoints through Batshit's same-origin proxy. The launch truth today:

- The optional `comfyui-validation` profile is a validation sidecar, not a full GPU ComfyUI install.
- Real ComfyUI is a connect-existing runtime unless a future approved sidecar is documented.
- Current ComfyUI panel Artifacts are user-run panels. They aren't agent runtime tools.
- HuggingFace and Gradio embeds are user-only panel runtimes too.

## Agent Use

A published Artifact becomes an agent-usable runtime tool only when Batshit can validate how an agent should call it. An agent-usable Artifact needs:

- Published status.
- Agent Use enabled.
- An allowed-agent scope, if it's not enabled for all agents.
- A valid runtime schema — typed Fabric fields or a run-only contract.
- A backend-runnable power source.

When that's valid, agents discover the Artifact through Artifact runtime tools and call it with typed values. The settings split: **Settings → Artifacts** owns the Artifact, publishing, zone, model, power source, and Agent Use master switches; **Settings → Agents → Access** owns which agents can access selected-agent Artifacts.

## Fabric fields

Fabric fields are inputs inside the Artifact that Batshit can expose to agents as typed parameters — text, dropdown, toggle, number, slider, multiselect, and so on. If an Artifact has a field labeled `prompt`, an agent can call it with a structured `prompt` value instead of clicking around the UI.

File inputs are not normal Fabric fields. For file-heavy workflows, use Clips, upload controls, or a specific backend contract.

## Share to Chat

Artifacts can share output back into chat. Standard controls: Share to Chat, Save to Clip Vault, and Download.

When an Artifact shares text, Batshit saves a visible user-role message. When it shares an image, Batshit stores it as a Clip — chat may show an optimized preview, while quick view, copied image URLs, and downloads use the original full-resolution image when Batshit has one. If the share targets the current chat, Batshit can trigger the assigned agent to respond. Agent-initiated image shares are handled carefully so the active turn doesn't accidentally start a second hidden follow-up turn.

## Artifact runtime safety

Artifact previews run in sandboxed iframes. The iframe does not get normal access to Batshit cookies, local storage, or the parent page; Batshit injects a scoped runtime token for Artifact API calls. That means:

- Artifacts should use `window.batshit` APIs instead of reading Batshit app internals.
- Artifact API-key access is opt-in per Artifact, and an Artifact can only request saved keys its record explicitly allowlists.
- Infrastructure keys are blocked from Artifact env access.
- Parent-page messages from the Artifact are accepted only when they match the rendered Artifact identity.

Don't import or publish untrusted Artifact code. An Artifact is still executable JavaScript in your local app, even with iframe boundaries.

## Structure enforcement

Batshit validates normal Artifact lifecycle writes. For backend-runnable Artifacts, the expected structure uses Batshit's Builder Kit and a Fabric runtime contract. This helps stop broken generated mini-apps from being saved as if they were ready.

If you intentionally want a raw embed or static/manual Artifact, use the explicit settings path for that Artifact. Don't rely on accidental validation gaps.

## Backups don't include external runtimes

Batshit backups include Artifact records and the Artifact runtime storage Batshit owns. They do not automatically include external runtimes:

- External n8n workflows and credentials.
- ComfyUI state.
- HuggingFace/Gradio external apps.
- Local model weights and sidecar data, unless a future add-on explicitly documents it.

Back those up through their own tools if you need exact recovery.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Artifact AI button fails | Missing model, missing webhook, wrong runtime transport, or a power source that can't complete. | Artifact Power Source, model/webhook settings, and recent Artifact run logs. |
| Agent can't discover a published Artifact | Agent Use is off, the allowlist is empty, or the runtime schema is missing. | Artifact Agent Use settings and Fabric fields. |
| Artifact generated text when you expected an image/file | Wrong model, unsupported output mode, missing saved provider key, or a non-file provider response. | Recent Artifact run logs for resolved model, transport, and output counts. |
| ComfyUI Artifact works in browser but not from Docker | Wrong caller URL. | Use a container-reachable URL or the Batshit proxy. |
| HuggingFace/Gradio embed isn't agent-usable | It's a user-only panel runtime. | Build a backend-runnable Artifact if agents need to call it. |
| Save/update fails validation | Missing Builder Kit, Fabric fields, run-only contract, or a script syntax issue. | Run validation and fix the reported issue. |

## Related docs

- [Artifacts and agent use](agent-use.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Projects and files](../projects/overview.md)
- [Clips](../clips/overview.md)
- [Security and trust](../security/overview.md)
