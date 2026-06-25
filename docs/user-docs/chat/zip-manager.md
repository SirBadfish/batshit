# The Zip Manager

The Zip Manager is the chat-side control room for Batshit's Zips — the compressed bundles Batshit makes from large tool and assistant output. From a single panel you can see every Zip in a conversation, jump to any of them, and decide what the model carries forward versus what stays tucked away.

This page is the UI. It assumes you already know *what a Zip is and why it exists* — if you don't, read [Zips and context](../tools/zips.md) first. That page is the canonical explanation; this one just shows you the buttons.

## Zip badges in the chat

When Batshit zips a piece of output — a long log, a big tool result, a generated image — it doesn't disappear. It shows up in the message stream as a card or an expandable item with a small **Zip badge**. The badge is both a status light and a control.

The badge tells you the Zip's state at a glance:

- A **clock with a number** means the item is temporarily unzipped, and the number is how many messages remain before normal behavior resumes.
- A **hand** means you changed this Zip's state by hand.
- The **agent-control marker** means an agent changed it (using zip-control permission, if you granted that).
- An **infinity icon** means it's being kept unzipped indefinitely.
- A plain zipped item shows only the zipped state, with no extra icon.

Hover or focus a Zip and its controls appear. Depending on the item's current state, you can:

- **Unzip it for a stretch** — keep it expanded and visible to the model for the next several messages, then let it return to normal.
- **Unzip it indefinitely** — hold it open until you decide otherwise.
- **Zip it now** — compress it immediately to save context.
- **Return to automatic** — drop your manual override and let normal Zip behavior take over again.

"Unzipped" here means the *model* can see the full content again on future turns — not just that you can read it. You can always read a Zip in the chat regardless; unzipping is about what the agent carries forward.

## The Zip Manager panel

The badges handle one Zip at a time. The Zip Manager panel handles all of them at once. Open it from the control in the Token row beneath the chat bar.

The panel lists the Zips in the current Session and gives you two ways to cut through them:

- **Filter** by `Unzipped`, `Zipped`, or `All`, so you can focus on just the items currently expanded, just the compressed ones, or everything.
- **Sort** by chat order, by manual changes first (your overrides and any agent-approved ones float to the top), by token size (biggest first), or by newest first.

Click any row and Batshit jumps to that item in the conversation and briefly highlights it — handy when you remember a result exists but not where it is in a long chat.

## What the badge count means

The Zip Manager's badge in the Token row counts **manually unzipped items only** — the ones you deliberately opened, plus any an agent opened through zip-control permission. It is *not* a count of every Zip in the chat. Think of it as "how many things am I currently holding open against the normal rules," which is exactly the number worth keeping an eye on, because held-open content is content the model keeps paying for.

A Zip you open is treated as yours: an agent shouldn't silently re-compress something you deliberately expanded. Your manual choices sit on top of Batshit's automatic buffer and threshold behavior, and they win.

## A note on timing

Changing a Zip while an agent is mid-answer affects the model's *next* calls and future sends — it doesn't rewrite what the already-running request has seen. The context meter in the [Token Panel](overview.md#the-token-panel-your-context-meter) updates to reflect the next send, so you can watch your changes take effect there.

## Related docs

- [Zips and context](../tools/zips.md) — what Zips are and why
- [The chat workspace](overview.md)
- [Clips Manager](clips-manager.md)
- [Execution Viewer](execution-viewer.md)
