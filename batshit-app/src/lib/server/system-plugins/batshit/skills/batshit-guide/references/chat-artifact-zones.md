# Artifact zones

Artifacts are reusable mini-apps you build inside Batshit — forms, dashboards, image generators, workflow launchers, and more. Artifact zones are how a *published* Artifact escapes the chat history and becomes a permanent part of your workspace, one click away while you talk.

A normal message scrolls away. An Artifact in a zone stays put: it's a saved interface you can open again and again without digging through the conversation that created it.

This page is about the chat-side experience — where published Artifacts show up and how you pick which one is visible. The full concept, including how Artifacts are built and made agent-usable, lives in [Artifacts](../artifacts/overview.md).

## Why zones exist

When an agent builds you a tool — a prompt-to-image panel, a custom n8n form, a model-comparison dashboard — you don't want it buried in chat scrollback. You want it parked somewhere reachable. Zones are those parking spots. Publishing an Artifact into a zone pins it to the workspace so it's always available, separate from the flow of messages.

## The three zones

A published Artifact can live in one of three places around the chat. Each feels a little different:

| Zone | What it feels like |
| --- | --- |
| **Header** | A small icon up in the header. Click it and the Artifact opens in an overlay — good for quick-launch tools you reach for often. |
| **Panel** | A widget docked in the side rail next to the chat — good for something you want open and visible *while* you work, like a dashboard or a running form. |
| **Trigger** | A compact dropdown-style widget — good for a small form or a button that stays tucked away until you open it, and stays open until you close it. |

There's also a **"no zone"** state. An Artifact that isn't assigned to a zone simply doesn't appear in the workspace; it's a draft or a gallery-only item until you give it a home.

The Artifact's outer frame — its title, icon, and open/close controls — belongs to Batshit. The Artifact's own body focuses on the actual controls and results, so a well-built Artifact opens straight into the useful part instead of repeating its own name back at you.

## Choosing which Artifact is visible

Zone assignment is a *setting on the Artifact*, not something you drag around the chat screen. You choose an Artifact's zone in **Settings → Artifacts**, where you also publish it, pick its icon, and decide whether agents may use it. Selecting a zone there is what makes the Artifact show up in the workspace; selecting "no zone" pulls it back out.

Once Artifacts are in their zones, the chat-side controls are about *display*, not editing:

- **Open and close** any zone widget as you go. Header icons pop open an overlay; the side panel opens beside the chat; a trigger widget expands and stays open until you dismiss it.
- **Reorder your header Artifacts** by dragging them, so your most-used tools sit where you want them. The order is remembered.

If you want to *change* what an Artifact does — its model, its power source, its fields, its agent permissions — that all happens back in Settings, not in the zone. The zones are the storefront window; Settings is the workshop.

## How this connects to the rest of Artifacts

Zones are just the visible tip. Everything else about Artifacts — the kinds of Artifacts (built-in AI, n8n workflow, ComfyUI panel, static widget, and more), how an agent builds one for you, how a published Artifact can become a tool an agent runs, and how Artifacts share output back into chat as Clips — is covered in the main Artifacts docs.

Start with [Artifacts](../artifacts/overview.md) for the mental model, then [Artifacts and agent use](../artifacts/agent-use.md) for the hands-on setup of publishing, zones, and agent permissions.

## Related docs

- [Artifacts](../artifacts/overview.md)
- [Artifacts and agent use](../artifacts/agent-use.md)
- [The chat workspace](overview.md)
- [Clips](../clips/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
