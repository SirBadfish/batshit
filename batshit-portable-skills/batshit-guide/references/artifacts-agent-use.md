# Artifacts and agent use

This is the hands-on guide: how to create an Artifact, make it agent-usable, and run it. For the mental model — what Artifacts are, where Zones live, and the iframe safety boundary — see the [Artifacts concept](overview.md).

Think of an Artifact as a small app with a clear job: a dashboard, prompt form, generator, calculator, workflow panel, image tool, ComfyUI launcher, or custom interface.

## Artifact power sources

The Power Source decides how an Artifact runs — and whether an agent can run it.

| Power source | What it means | Agent-runnable at launch? |
| --- | --- | --- |
| Built-in AI | Batshit calls the selected model through the direct `API` path. | Yes, when published with a Fabric field or run-only contract. |
| n8n Workflow | Batshit calls a saved n8n webhook. | Yes, when built as a backend-runnable Artifact. |
| Custom Webhook | Batshit calls a custom webhook you provide. | Yes, when the webhook Artifact has the required contract. |
| Static / No AI | A local UI only. | No — agent-runnable tools need a backend power source. |
| ComfyUI | User-run panel through Batshit's ComfyUI proxy. | No for current panel artifacts. |
| HuggingFace | Embedded HuggingFace/Gradio-style UI. | No for current embeds. |
| Gradio | Embedded standalone Gradio UI. | No for current embeds. |

Static / No AI, ComfyUI, HuggingFace, and Gradio panels are still useful to you — they just aren't published as agent tools unless Batshit has a backend runtime path (Built-in AI, n8n Workflow, or Custom Webhook).

## Create or edit an Artifact

The normal creation path is skill-led:

1. Ask a capable agent to use Batshit's Artifact Creator skill.
2. Answer any focused setup questions.
3. Let the agent create the Artifact through Batshit's Artifact controls.
4. Review it in Settings → Artifacts.
5. Pick the Zone where it should appear.
6. Publish it when ready.

You can also manage Artifacts manually in Settings → Artifacts. Fields worth knowing:

- **Name** — the visible Artifact name.
- **Zone** — where it appears in the workspace (Header, Panel, or Trigger).
- **Artifact Power Source** — how it runs.
- **Webhook URL** — used by n8n Workflow and Custom Webhook Artifacts.
- **Advanced Builder** — raw details for users who know what they're changing.

Built-in AI Artifacts can carry their own selected model, but normal Artifact Settings doesn't expose a model preset picker. The builder/agent should use Batshit's model catalog and store an exact model ID on the Artifact when the model is part of its purpose, or pass an exact runtime model in each call. For generated-image Artifacts, the selected catalog result must be image-capable (not just broadly visual), and any required direct provider key must be saved in Batshit.

## What makes an Artifact agent-usable

An agent-runnable Artifact needs all of this:

- The Artifact is published.
- Agent Use is enabled.
- It has a runtime contract: typed Fabric fields, or explicit run-only metadata.
- It's allowed for the agent that should use it.
- The power source has a backend-runnable path.

Typed Fabric fields are form fields the agent can set safely:

- text
- textarea
- select
- multiselect
- checkbox
- toggle
- radio
- slider
- number
- prompt pair

File inputs are not agent-settable Fabric fields at launch. For generated-image Artifacts, builders can still expose source or reference images to agents using text fields that accept an image URL or data URI. When the Artifact uses an image-capable Built-in AI model, Batshit maps common field names like `source-image-1-url`, `image-count`, `aspect-ratio`, and `resolution` into the structured image request instead of treating them as prompt text. User-operated image Artifacts can also offer Clip Vault source picking: Batshit lists image clips as metadata first, then resolves the selected clip into a tunnel/public URL when one's available, falling back to stored image data with size limits so very large local images fail clearly instead of silently breaking the request.

## Enable Agent Use

1. Open Settings → Artifacts.
2. Select the published Artifact.
3. Confirm it has real typed fields or a run-only contract.
4. Turn on Agent Use.
5. Choose whether all agents or selected agents can use it.
6. If using selected agents, assign the Artifact in Settings → Agents → Access.
7. Save/publish the Artifact state.
8. Ask the allowed agent to find and run it.

Here's one that's easy to fuck up: if Agent Use is on but you chose **selected agents** and assigned none, *no agent can see it*. An empty allowlist in selected-agents mode means invisible, not "everyone." Either assign agents or switch to all-agents.

## How agents find Artifacts

Agents don't need every Artifact dumped into their prompt. Batshit exposes published Artifact runtime tools as one family inside Dynamic Tool Search/Use:

1. The agent searches for available Artifact runtime tools.
2. Batshit returns only Artifacts the agent is allowed to see.
3. The agent calls the Artifact with typed input.
4. Batshit validates the fields and runs the Artifact backend.
5. Results come back as a tool result, and generated files can be shared to chat.

This is different from Artifact build/manage controls. Build/manage controls create, edit, publish, and configure Artifacts; runtime tools *run* an already-published Artifact.

When a runtime call fails or returns the wrong kind of output, agents can inspect scrubbed Artifact run logs — related chat message, a short scrubbed prompt preview, selected model, transport path, output counts, and sanitized errors. The logs never store API keys, auth tokens, or raw image/audio bytes, are retained about two weeks, are deleted immediately when the Artifact is deleted, and are kept across version edits/rollbacks/deletions.

## Share to Chat

Artifacts can share output back to the current chat: text or Markdown, images, generated files, or saved Clip Vault entries.

When an Artifact shares to chat, Batshit saves a visible user-role message and can trigger the assigned agent to respond. Image shares may display an optimized preview in chat, while quick view, copied URLs, and downloads use the original full-resolution image when available. Agent-initiated shares avoid creating an extra hidden follow-up turn, because the original agent turn is already running.

## Artifact API keys

Artifacts don't get ambient access to all saved API keys. If an Artifact needs a saved key:

1. The Artifact record must explicitly allow that key name.
2. The Artifact calls Batshit's scoped artifact key route.
3. Batshit checks ownership/published access and the allowlist.
4. Missing allowlist entries fail instead of silently exposing secrets.

Don't build Artifacts that expect provider keys to be available just because the user saved them in Batshit.

## n8n Workflow Artifacts

n8n Workflow Artifacts call a saved n8n webhook.

1. Build or import the n8n workflow.
2. Activate it in n8n.
3. Copy the Production webhook URL.
4. In the Artifact, set Artifact Power Source to n8n Workflow.
5. Save the webhook URL.
6. Test from the Artifact UI.
7. Publish and enable Agent Use only after the runtime contract is valid.

In Docker, runtime calls to saved loopback n8n URLs are rewritten through the Docker-reachable n8n base — `http://n8n:5678` for the optional Docker n8n profile, or `http://host.docker.internal:5678` for host-managed n8n.

## Custom Webhook Artifacts

Custom Webhook Artifacts call your own service. The service should accept the payload Batshit sends, return JSON or text, fail with useful errors, not require browser-only cookies, and be reachable from the Batshit runtime that calls it. For Docker Batshit calling a host service, use `host.docker.internal` when needed.

## ComfyUI Artifacts

Current ComfyUI Artifacts are user-run panel artifacts. They call Batshit's same-origin ComfyUI proxy from the iframe, and the proxy talks to ComfyUI — don't make Artifact JavaScript call ComfyUI cross-origin directly from the browser.

In Docker:

- a ComfyUI sidecar can use an app-container URL like `http://comfyui:8188`
- a host ComfyUI service usually uses `http://host.docker.internal:8188` for app-container calls
- the optional `comfyui-validation` profile is a validation fixture, not full GPU ComfyUI

Current ComfyUI panel Artifacts aren't agent-runnable tools. If an agent needs to run a ComfyUI workflow, build a backend webhook/runtime Artifact or wait for a launch-supported backend ComfyUI runner.

## HuggingFace and Gradio embeds

HuggingFace and Gradio embed Artifacts are user-only panel artifacts at launch. They're useful when you want a saved embedded interface in Batshit, but the embedded Space or Gradio app owns its runtime outside Batshit. Agent Use controls are intentionally hidden or disabled for these types.

## Generated images and files

Artifact completions can return generated files, including images. Batshit stores safe summaries for agent tool results and can auto-share a generated image into the active chat as a Clip-backed message — it should not dump raw base64 into the transcript or tool result.

When an agent builds or tests an image-generating Artifact, it should inspect recent Artifact run logs and confirm the run produced at least one generated file. A published Artifact that runs but produces zero files is still a failed image generator.

## Docker callback notes

Artifact runtime calls are server-side. In Docker, the default Artifact Complete URL should normally be internal:

```text
http://app:3000/api/artifacts/complete
```

The browser still uses:

```text
http://localhost:5620
```

Don't copy a browser `localhost` URL into a server-side callback unless you know which caller will use it.

## Safe Artifact rules

- Don't enable Agent Use for Artifacts from untrusted sources without reading them.
- Don't grant Artifact key access unless the Artifact genuinely needs that key.
- Don't treat embedded third-party UIs as if Batshit owns their backend.
- Keep webhook URLs private if they can trigger real actions.
- Test Artifact runtime from the same install path the user will actually use: Mac app/host, Docker, or remote.

## Related docs

- [Artifacts](overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Clips](../clips/overview.md)
