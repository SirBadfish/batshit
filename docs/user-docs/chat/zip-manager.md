# The Zip Manager

The Zip Manager is the chat-side control room for Batshit's Zips — the compressed bundles Batshit makes from large tool and assistant output. From a single panel you can see every Zip in a conversation, jump to any of them, and decide what the model carries forward versus what stays tucked away.

This page is the UI. It assumes you already know *what a Zip is and why it exists* — if you don't, read [Zips and context](../tools/zips.md) first. That page is the canonical explanation; this one just shows you the buttons.

## Zip badges in the chat

When Batshit zips a piece of output — a long log, a big tool result, a generated image — it doesn't disappear. It shows up in the message stream as a card or an expandable item with a small **Zip badge**. The badge is both a status light and a control.

The badge tells you the Zip's state at a glance:

- A **clock with a number** means the item is held for a few messages (or the buffer is about to let it go), and the number is how many messages remain before normal behavior resumes.
- A **hand** means you hold it, or changed it by hand.
- The **agent marker** means an agent holds it: a file the agent read and chose to keep open. Hover the badge to see which agent, such as "Held by Scout".
- A **lightning bolt** means [Judge Juice](../judge-juice/overview.md) holds it open for a message or two, if you turned on **Judge Juice: Smart Zip**; hovering says "Held by the judge (2 messages left)". It always comes with a short countdown, and it's never a lock: your own choice, or the agent's, replaces it. A result Judge Juice zipped after a reply says "Compressed by the judge" when you hover its badge.
- An **infinity icon** means it's held until someone releases it.
- A compressed item shows only the compressed state, with no extra icon. Hovering says "Compressed", or who zipped it ("Compressed: you zipped it"). An old copy of a file that the agent read again, or edited since, is compressed whatever its buffer says; hovering its badge tells you why ("Compressed: superseded by a later read").

Hover the badge to read who holds it: "Held by you", "Held by you (3 messages left)", or "Held by" and the agent's name.

Hover or focus a Zip and its controls appear. Depending on the item's current state, you can:

- **Hold for 10 messages** — keep it open for the model for the next ten messages, then let it return to normal. A Cool Tool result at 25,000 tokens or more cannot be held open whole.
- **Hold** — keep it open until you release it. You can also hold something an agent holds; it becomes yours. A Cool Tool result at 25,000 tokens or more cannot be held open whole.
- **Zip now** — compress it immediately to save context.
- **Release** — drop your hold (or an agent's) and let normal Zip behavior take over again. An old copy an agent still holds offers Release too, even though it is already compressed.

An agent's hold stays when you switch the chat to another agent, until you release it. Deleting an agent releases all of its holds.

"Held" and "open" here mean the *model* can see the full content on future turns — not just that you can read it. You can always read a Zip in the chat regardless; holding is about what the agent carries forward.

## The Zip Manager panel

The badges handle one Zip at a time. The Zip Manager panel handles all of them at once. Open it from the control in the Token row beneath the chat bar.

The panel lists the Zips in the current Session and gives you two ways to cut through them:

- **Filter** by `Expanded`, `Compressed`, or `All`, so you can focus on just the items currently expanded, just the compressed ones, or everything.
- **Sort** by chat order, by manual changes first (your overrides and any agent-approved ones float to the top), by token size (biggest first), or by newest first.

Click any row and Batshit jumps to that item in the conversation and briefly highlights it — handy when you remember a result exists but not where it is in a long chat. **Zip all expanded** compresses everything currently expanded at once.

## What the badge count means

The Zip Manager's badge in the Token row counts **items held open against the normal rules** — the ones you hold, the files an agent holds, and any Judge Juice has open for a message or two. The panel's summary line shows how many items are expanded, their tokens, and how many are **held**: every hold counts, whether it lasts until released or for a few messages. It is *not* a count of every Zip in the chat. Think of it as "how many things am I currently holding open against the normal rules," which is exactly the number worth keeping an eye on, because held-open content is content the model keeps paying for.

A Zip you hold is yours: an agent can't release it, re-compress it, or hold it over you, and it sees in its own context that you hold it. Your holds sit on top of Batshit's automatic buffer and threshold behavior, and they win.

## A note on timing

Changing a Zip while an agent is mid-answer affects the model's *next* calls and future sends — it doesn't rewrite what the already-running request has seen. The context meter in the [Token Panel](overview.md#the-token-panel-your-context-meter) updates to reflect the next send, so you can watch your changes take effect there.

## Related docs

- [Zips and context](../tools/zips.md) — what Zips are and why
- [The chat workspace](overview.md)
- [Clips Manager](clips-manager.md)
- [Execution Viewer](execution-viewer.md)
