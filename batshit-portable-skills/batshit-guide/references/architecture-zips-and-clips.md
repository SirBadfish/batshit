# Zips and Clips under the hood

Batshit keeps two views of every conversation — a full one for you and a compact one for the model — and Zips and Clips are the machinery that keeps them in sync without dragging files and giant results through every request. This page explains how that split works, why it exists, and the subtle risk it has to manage. For what Zips and Clips *are* and how to use them, the feature pages stay canonical: [Zips](../tools/zips.md), [the Zip Manager](../chat/zip-manager.md), and [Clips](../clips/overview.md).

## Two views of every message

A model has no memory between calls. Every turn re-sends the whole conversation, so anything bulky you said ten messages ago gets paid for again on every message after it. But you still want to *read* that bulky thing in the chat. Those two needs pull in opposite directions, so Batshit stops pretending one representation can serve both.

Each message is compiled twice from the same stored data:

- A **human-facing view** expands everything — full logs, full tool output, full images — because that's what you want to see.
- A **model-facing view** keeps the same conversation but compresses the bulky parts into small references, and only re-inflates one when it's genuinely needed.

The chat you read and the request the model receives come from the same source, shaped for two different audiences. That's the whole reason a long, tool-heavy session on Batshit stays affordable: the model isn't carrying the screenshots and the 800-line logs you're scrolling through — it's carrying compact stand-ins for them.

The honest risk here is that two views of the same thing can disagree. If the model-facing view loses a fact the human-facing view still shows, you'd see a correct chat while the model worked from something stale — a bug that's invisible to you. Batshit treats keeping the two views in agreement as a first-class job, which is why the rules below are strict about what counts as "needed" and what gets left expanded.

## Zip references versus expanded bodies

A Zip is a reference to content stored on your own instance. In the chat it expands into a normal card or panel you can read; for the model it stays a tiny reference until something earns it a full re-read. Three things do:

- **The recent buffer.** The last few agent responses stay expanded for the model, because that's the context an agent most likely still needs to keep working. Older results compress as the conversation moves past them.
- **A manual unzip.** You can open a Zip so the model sees it in full again on the next turn. Content you unzip is treated as **yours** — an agent shouldn't silently re-compress something you deliberately opened. (An agent can request Zip changes too, but only if you've granted that permission.)
- **A genuine need.** Tool results are stored as Zips from the moment they finish, so the full output never has to live in the message body. When an agent truly needs raw content, it can fetch the Zip directly instead of being handed it on every turn.

There's a deliberate exception that protects the *next* request rather than the past one. A single enormous result — a giant file read, a huge diff, a long terminal dump — can stay compressed even inside the recent buffer. Without that guard, one oversized result sitting in the buffer could inflate the next request past a provider's or tool's size ceiling. The output stays fully inspectable in the chat; it just doesn't get force-fed back into the model when it would do more harm than good.

This is also why your manual choices win. A Zip you opened stays open against the normal rules, and Batshit won't trim or compact away the message carrying it while you're holding it open. The buffer-and-threshold behavior is the default; your hand on the controls overrides it. The full button-by-button version of this lives in [the Zip Manager](../chat/zip-manager.md).

## Clips: stored once, referenced everywhere

A Clip solves the same cost-and-clarity problem from the other direction — for the files and images *you* bring in, instead of the output an agent produces. You upload a Clip once, and from then on Batshit references it wherever it's used instead of re-embedding it.

The part that matters most is how images travel. An image reaches the model as **structured image input** — a proper image attachment the model is built to receive — never as raw image bytes pasted into the prompt as text. That distinction is the entire reason images don't blow up your token cost: a screenshot dropped into prompt text would balloon into a wall of unreadable characters and get paid for on every later turn, while a structured image input is handled as an image and doesn't poison the conversation log. The rule for you is just "upload images as Clips," and this is why.

A Clip is also stored in one shape but delivered in whatever form the moment actually calls for. The model-facing address is resolved **late** — at send time, from your current settings and runtime — while the chat keeps showing a stable local preview. That late resolution is what lets the same uploaded Clip work for a local model, a cloud model, or an agent reaching Batshit from somewhere else, without you re-uploading anything or the chat view ever changing under you. The trade-off pages — which transport gets picked, and the "works in my browser but not for the agent" gotcha — are covered in [Clips](../clips/overview.md).

## Fail clearly, don't fake it

Because Zips and Clips are references, a reference can occasionally point at something that can't be resolved right then. When that happens, Batshit shows a clear missing-content state instead of quietly substituting a guess or retrying behind your back. A Zip whose content can't be loaded reads as a plain missing-result card; a Clip that can't be reached for the model surfaces as a real error rather than a silent drop.

This is a deliberate stance, not a rough edge. A hidden fallback would let a broken reference masquerade as working content — exactly the kind of "the two views disagree" failure this whole design exists to prevent. Honesty about a missing piece is worth more than a convincing fake of a present one.

## How this ties back to token cost

Zips and Clips are the per-item half of Batshit's cost story: Zips keep bulky output from riding along forever, and Clips keep files and images out of prompt text entirely. The other half is *request shape* — assembling each request so its stable front stays reusable and provider caching can build on it. That's a separate page: [Context, caching, and token optimization](context-caching-tokens.md).

## Related

- [Zips](../tools/zips.md) · [The Zip Manager](../chat/zip-manager.md) · [Clips](../clips/overview.md)
- [Context, caching, and token optimization](context-caching-tokens.md)
- [How Batshit works](overview.md)
