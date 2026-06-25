# Embedding a Gradio App as an Artifact

This is the simplest artifact you can build. A Gradio app embedded directly into Batshit — works great, takes about 10 lines of HTML.

**Important:** this is a raw embed, not a Builder Kit + Fabric artifact. Batshit blocks that by default now, so the user must manually turn off **Enforce Batshit Artifact Structure** for this artifact in Settings -> Artifacts before the embed can save.

---

## Before You Build — Tell the User What They're Getting

**You MUST explain this before proceeding.** Say something like:

> "I can embed this as a quick artifact — it'll look and work just like the original. Just so you know: because it's an embedded app from somewhere else, your AI agents won't be able to use it as a tool, and the Share to Chat / Save to Clip Vault / Download buttons won't be available. If you want those features, I can build a custom version instead. Totally up to you!"

Wait for the user to confirm they want the embed path before proceeding.

Also tell them plainly: *"Batshit now enforces Builder Kit + Fabric by default, so for this quick embed path you'll need to turn off the Enforce Batshit Artifact Structure toggle for this artifact in Settings first."*

---

## The Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SPACE_TITLE</title>
  <script type="module" src="https://gradio.s3-us-west-2.amazonaws.com/6.14.0/gradio.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { color-scheme: dark; }
    html, body { width: 100%; height: 100%; background: var(--batshit-bg, #0a0a0a); }
    gradio-app { display: block; width: 100%; min-height: 100vh; }
  </style>
</head>
<body>
  <gradio-app
    space="USERNAME/SPACE-NAME"
    eager="true"
    theme_mode="dark"
    initial_height="100vh"
    autoscroll="true"
    container="false"
  ></gradio-app>
</body>
</html>
```

Replace `SPACE_TITLE` with a name and `USERNAME/SPACE-NAME` with the Gradio app identifier (e.g., `not-lain/background-removal` for HF Spaces). For non-HF Gradio apps, use `src="https://your-server.com"` instead of the `space` attribute.

---

## Rules

1. **NEVER use `<iframe>`** — HuggingFace and many Gradio hosts block it via X-Frame-Options. It will show a blank page. Use `<gradio-app>` only.
2. Set `ai_enabled: false` and `brain_type: none` — the embedded app has its own AI.
3. Set `icon_ref` to `{ kind: "brand", slug: "huggingface-color" }` for Hugging Face-hosted Spaces, or `{ kind: "brand", slug: "gradio-color" }` for non-Hugging Face Gradio apps. Do not send raw emoji icons.
4. Set `metadata.source_type` to `huggingface` for Hugging Face-hosted Spaces, or `gradio` for non-Hugging Face Gradio apps.
5. Set `agent_use_enabled: false` — Gradio/HuggingFace embeds are user-only and will not appear in Agent settings.
6. Zone: **panel** (Gradio apps need scroll room).
7. **Clean embed only** — no wrapper buttons, status bars, headers, troubleshooting UI, or Builder Kit controls. Just the `<gradio-app>` filling the full artifact area.
8. **Do NOT load `fabric-and-agent-use`** — Gradio embeds don't support Fabric. There's nothing to configure.

**Local cache boundary:** This embed path is remote/browser-facing only. Do not clone a Space, run a local Gradio server, or download Hugging Face model weights from the artifact skill. If the user wants a local runtime version, move that work to the relevant runtime/Engine Manager setup so storage and deletion are tracked.

## Gradio JS Version

Use a Gradio web component that matches the app's Gradio major version. For Hugging Face Spaces, fetch `https://USERNAME-SPACE-NAME.hf.space/config` and read the `"version"` field when possible. Current Gradio 6 apps need a Gradio 6 component such as `https://gradio.s3-us-west-2.amazonaws.com/6.14.0/gradio.js`; do not pin a 5.x component for a 6.x app.

## That's It

Create via `sys.artifact.create`, set the zone to panel, publish. Done, but only after the user manually disabled structure enforcement for that artifact.
