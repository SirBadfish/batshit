# HuggingFace Artifact Guide

You're helping a user build an artifact involving HuggingFace. This is usually one of two things: embedding an HF Space directly (the easy path) or building an artifact that calls HuggingFace's Inference API. This guide covers both.

## Step 0: Pick the Contract Before You Code

Batshit now enforces artifact structure at save time unless the user manually turned that toggle off for this artifact in Settings -> Artifacts.

- Native Batshit artifacts must use **Builder Kit**
- Native Batshit artifacts must declare a **Fabric runtime contract**
- Quick HF Space embeds are raw embed artifacts, so the user must manually disable structure enforcement first if they choose that path

Decide which contract applies before you write anything:

1. **Embed path** -> raw Gradio/HF Space artifact, no Builder Kit/Fabric, user must disable enforcement first
2. **Native HF API path** -> normal Batshit artifact, Builder Kit + Fabric required from the start

Do not blur these two paths together. If you start with embed-style HTML for a build that really wants agent use, theming, and action controls, you are starting from the wrong mental model.

---

## Which Path? Embed or Build Custom?

Ask the user if their intent isn't clear:

- **"Embed the Space"** → The user wants the actual HF Space running inside Batshit. Quick, easy, ~10 lines of HTML. This is Path A below.
- **"Build a custom tool"** → The user is inspired by a Space but wants a native Batshit artifact with theming, agent access, and action buttons. This is really a standard artifact build — load `brain-general` instead of this doc.
- **"Use HuggingFace's API"** → The user wants an artifact that calls HF Inference endpoints directly. This is Path B below.

**Always mention the Fabric tradeoff** when the user is considering an embed: "Embedded Spaces can't be used by your AI agents as tools, and the Share/Save/Download buttons won't be available. If you want those features, I can build a custom version instead."

### Quick Decision Rule

- If the user wants the actual Space running as-is -> stay on the embed path
- If the user wants Batshit-native theming, agent use, or action buttons -> switch to the native artifact path and load `brain-general`

---

## Path A: Embed an HF Gradio Space

### Before You Build — Tell the User

**You MUST explain this before proceeding.** Say something like:

> "I can embed this Space as a quick artifact — it'll look and work just like the original. Just so you know: because it's an embedded app from HuggingFace, your AI agents won't be able to use it as a tool, and the Share to Chat / Save to Clip Vault / Download buttons won't be available. If you want those features, I can build a custom version instead. Totally up to you!"

Wait for the user to confirm before proceeding.

Also tell them one more important thing: Batshit now blocks raw/manual artifact saves by default. If they want the quick embed path, they need to manually turn off **Enforce Batshit Artifact Structure** for that artifact in Settings -> Artifacts first. If they want to keep enforcement on, build a native Batshit version instead.

### The Template

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

Replace `SPACE_TITLE` with a name and `USERNAME/SPACE-NAME` with the HF Space ID (e.g., `not-lain/background-removal`).

### Rules for Embeds

1. **NEVER use `<iframe>`** — HuggingFace blocks it. Blank page guaranteed. Use `<gradio-app>` only.
2. Set `ai_enabled: false` and `brain_type: none` — the Space has its own AI.
3. Set `icon_ref` to `{ kind: "brand", slug: "huggingface-color" }`. Do not send raw emoji icons.
4. Set `metadata.source_type` to `huggingface` so Batshit can show the Hugging Face source badge.
5. Set `agent_use_enabled: false` — embedded Spaces are user-only and will not appear in Agent settings.
6. Zone: **panel** (Gradio apps need scroll room).
7. **Clean embed only** — no wrapper buttons, headers, status bars, troubleshooting UI, or Builder Kit controls. The body should contain only the `<gradio-app>`.
8. **Do NOT load `fabric-and-agent-use`** — embeds don't support Fabric.

### Gradio JS Version

Use a Gradio web component that matches the Space's Gradio major version. Fetch `https://USERNAME-SPACE-NAME.hf.space/config` and read the `"version"` field when possible. Current Gradio 6 Spaces need a Gradio 6 component such as `https://gradio.s3-us-west-2.amazonaws.com/6.14.0/gradio.js`; do not pin a 5.x component for a 6.x Space.

### That's It for Embeds

Create via `sys.artifact.create`, set zone to panel, publish. Done, but only after the user manually disabled structure enforcement for that artifact.

---

## Path B: Using HuggingFace Inference API

For when the artifact calls HF endpoints directly from its JavaScript. This produces a native Batshit artifact — with theming, action buttons, and full Fabric support.

**Local cache boundary:** Hugging Face artifacts call remote Spaces, remote Inference API endpoints, or the user's configured HF MCP gateway. Do not install model weights, clone repositories, or populate local Hugging Face caches from the artifact skill. If the requested experience needs local model weights or a local server, route it through the appropriate local-runtime/Engine Manager setup so disk ownership and deletion are tracked.

### HF Token Setup

The user needs their HuggingFace token saved in Batshit: **Settings → API Keys**. The artifact accesses it via:

```javascript
const hfToken = await window.batshit.env('huggingface');
if (!hfToken) {
  // Tell the user they need to add their HF token in Settings → API Keys
}
```

### Calling HF Inference Endpoints

```javascript
// Text generation example
const response = await fetch('https://api-inference.huggingface.co/models/MODEL_ID', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${hfToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ inputs: userPrompt })
});
const result = await response.json();

// Image generation example
const imgResponse = await fetch('https://api-inference.huggingface.co/models/MODEL_ID', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${hfToken}` },
  body: JSON.stringify({ inputs: userPrompt })
});
const blob = await imgResponse.blob();
const url = URL.createObjectURL(blob);
```

### For the Full Build Process

This is a standard artifact build that happens to use HF's API. Load `brain-general` for the step-by-step build process, then load `fabric-and-agent-use` when you're ready to publish.

---

## Discovering HF Spaces (Optional: HF MCP)

If the user has HuggingFace MCP or another HuggingFace inspection tool available in your current lane, you can search for Spaces programmatically.

**Setup for HF MCP**: User saves their HF token in Settings → API Keys, then adds `https://huggingface.co/mcp` as a Custom Gateway with the HF key selected for auth.

The main useful tool is searching for Spaces — if you already know which Space the user wants, you probably don't need MCP at all.
