# The Clips Manager

The Clips Manager is the chat-side panel for your Clips — the reusable files and images you've saved in Batshit. From the composer you can open it, browse everything you've stored, and attach a Clip to the message you're about to send, without re-uploading or pasting raw data into the chat.

This page covers the UI. It assumes you already know *what a Clip is and why it exists* — if you don't, start with [Clips](../clips/overview.md). That's the canonical concept page; this one is just the controls.

## Opening the Clips Manager

The Clips Manager lives in the composer, opened from the attach (paperclip) control. Its button also shows a small count of how many Clips are currently attached to your message, so you can tell at a glance whether anything is riding along with your next send.

It's also where you upload a new file: dropping or choosing a file here saves it as a Clip and attaches it, so "upload" and "attach" are the same motion the first time.

## Browsing and attaching

The panel is split into two parts:

- **Clipped items** — the Clips attached to the message you're composing right now.
- **Clip Vault** — your saved Clips, the full library you can pull from.

Attaching is a click: pick a Clip from the Vault and it joins your clipped items for this message. Click an attached Clip again, or use its remove (X) control, to take it back off. Nothing is deleted from your Vault when you remove it from a message — you're only changing what's attached to *this* send.

## How long a Clip stays attached

By default, an attached Clip stays clipped to the composer across sends until you remove it — useful when an agent should keep considering the same image or file over several messages.

You can also mark a Clip as **next message only**. A Clip in that mode is used for a single send and then drops off the composer automatically, so it doesn't quietly linger in later messages. When a Clip is in next-message-only mode, the panel labels it so you know it's a one-shot. Reach for this when you want an agent to look at something once and move on.

## A quick image-analysis flow

1. Open the Clips Manager and upload (or pick) the image.
2. Leave it clipped if the agent should keep referring to it; mark it next-message-only if it's a one-time look.
3. Send your question.
4. Remove it when the conversation no longer needs it.

Because Batshit sends images as structured image inputs rather than raw text, this keeps your conversation readable and your token usage sane — the reason Clips exist in the first place.

## When a Clip doesn't reach the agent

If a Clip looks fine in your browser but an agent or Artifact can't see it, the issue is almost always a URL-reachability mismatch, not the Clip itself — for example, a model or runtime that can't reach the address Batshit handed it. And if the selected model has Vision turned off, Batshit blocks image Clips before sending and tells you, rather than letting them fail silently downstream. Both situations, and how to fix them, are covered in [Clips](../clips/overview.md) and [Ports and URLs](../reference/ports-and-urls.md).

## Related docs

- [Clips](../clips/overview.md) — what Clips are and why
- [The chat workspace](overview.md)
- [Zip Manager](zip-manager.md)
- [Projects and files](../projects/overview.md)
