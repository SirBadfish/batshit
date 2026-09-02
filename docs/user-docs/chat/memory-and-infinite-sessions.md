# Memory & Infinite Sessions

Most AI chats forget everything the moment you close them. Batshit's memory system changes that: an agent with memory enabled remembers you — across chats, across days, with photos, and with an honest paper trail you can inspect and edit at any time.

An **Infinite Session** takes it further: one chat that becomes the agent's ongoing life. No more "new chat, re-explain everything." The conversation just continues, and older stretches gracefully move into searchable memory instead of falling off a cliff.

Both features are opt-in and start turned off.

## The three kinds of memory

Batshit uses three plain labels, and you'll see them everywhere — in settings, in the Memory Panel, and in what agents say:

- **Awareness** — what the agent simply knows right now: the recent conversation plus the memories it deliberately keeps in front of itself at all times (like "Josh's birthday is coming up" — optionally with an expiry so it can let go afterward). An Awareness memory can also keep one of its pictures visibly in the agent's standing awareness on every message.
- **STM (Trigger Memories)** — memories attached to trigger words. Say "Maggie" and the agent instantly *knows* about Maggie — no search, no delay, like hearing a name and remembering the person. Trigger Memories can carry photos: save one from a Clip and a vision-capable agent sees the picture when the memory fires. When the agent deliberately recalls a photo memory while answering, supported API models and Codex CLI can see it in that same reply too.
- **LTM (Long-term Memory)** — everything else, searchable. The agent "thinks a little harder": it searches by meaning, by keywords, and by time ("what were we doing last week?").

When an agent saves a memory, it picks where it belongs. You can see and change every choice.

## What "remembering" looks like in chat

- A small **Memory saved** chip appears under an agent reply that stored something. Click it to see what was saved.
- A **memories surfaced** chip appears when memories were pulled into the conversation. Click it to see which memories, whether a trigger word fired them or the agent searched for them, and how long each one is lingering.
- The [Execution Viewer](execution-viewer.md) has a **Memory Context** section showing exactly which memories the agent received on any turn — nothing is invisible.
- When facts change, agents **supersede** instead of delete: "your favorite color is green" replaces blue, but blue stays in history, clearly flagged as outdated. Ask "what used to be my favorite color?" and the agent can tell you.

## Turning memory on

Memory is **per agent** and off by default:

1. Open **Agent Settings** for the agent, on the **Core** tab.
2. Find the **Agent Memory** card and flip the toggle on.
3. The first enable downloads a small local embedding model (about 325 MB, one time) with a visible progress bar. This is what makes memory search work **without any API key** — everything runs on your machine.

That's it. The agent can now save and recall memories in ordinary chats. You don't need an Infinite Session to use memory.

The same card holds the tuning knobs (sensible defaults; you can ignore them): how long inserted memories "linger" (one default for trigger memories, one for recalled ones), token budgets for inserted memories, and the Infinite Session window settings described below. A single Trigger Memory can also carry its own linger setting — a custom number of messages, or "rest of the episode" so one mention keeps it present until that chapter of the conversation ends. Edit that per-memory setting in the Memory Panel, or let the agent set it when it saves.

## Infinite Sessions

An Infinite Session is a one-agent chat that lives indefinitely. Create one from the **session menu** (the three-dot menu on a chat in the sidebar) — but note:

- Only a **brand-new chat** (no messages yet) can become an Infinite Session.
- It's a **one-way choice**. An Infinite Session can never convert back to a regular chat. Batshit asks you to confirm, and suggests setting a custom Session ID first while that's still possible.
- It **auto-locks** (so you can't delete it by accident — you can still deliberately unlock and delete; your data is always yours).
- It's **pinned** in its own sidebar section, outside the folder system.
- **Group chat is not supported** in Infinite Sessions — it's one agent living one conversation. Use a regular session for groups.

### Episodes, in plain words

Life in an Infinite Session is organized into **episodes** — natural stretches of conversation, like "that afternoon we planned the trip." A long break (8 hours by default) ends an episode; the agent can also mark one finished, or hold one open ("we're continuing this tomorrow" keeps everything exactly as-is overnight).

Why this matters: when the conversation gets long, Batshit never chops off "the oldest N messages" mid-task. Instead, **finished episodes graduate**: they're summarized into memory, the summary takes their place in the conversation, and the full original messages stay stored and searchable. The agent keeps perfect recall of recent conversation (a guaranteed "floor"), keeps the story line of graduated episodes, and can search everything older. Nothing is deleted — ever — unless you delete it.

### Naps

When one very long conversation gets close to the model's context limit, the agent takes a **nap** — a between-turns cleanup that graduates finished episodes, compresses stale tool output, and if needed condenses the oldest part of the current episode while promoting the important working facts onto an **episode whiteboard** the agent keeps in front of itself. You'll see a Nap button in the token panel (replacing Compact, which is intentionally disabled in Infinite Sessions), and every nap leaves a visible record of what it did.

One setup note, honestly: **nap and graduation summaries need a model that can write them.**

- `API` agents: work out of the box.
- Codex `CLI` agents: work out of the box.
- Claude `CLI` agents: need a saved **API-compatible compact/summary model preset** (pick one in the Auto Compact settings or the Agent Memory card). Until then, naps fail with a clear message telling you exactly that — nothing breaks silently.

### Dreaming

Between conversations — never during one — the agent's memory "dreams": it merges duplicate memories, repairs supersession chains, processes expiries, and graduates episodes that finished while you were away. Every dream run writes a visible log with a plain-English reason for every action. You can watch it (or trigger it yourself with **Dream Now**) in the Memory Panel.

## The Memory Panel

**Settings → Memory** is your window into everything an agent has stored, with one card per kind of memory. Nothing the agent remembers is hidden from you:

- The **Awareness** card, in exactly the order the agent sees it — including stored entries that no longer compile (expired or superseded).
- The **Trigger Memories (STM)** card, with each memory's trigger words shown.
- The **Long-Term Memories (LTM)** card for saved facts.
- The **Graduated History** card: the readable summaries of older conversation that graduated into memory, searchable, with dates and the source chat. (Read-only for now.)
- Every memory shows full content, dates, importance, attached photos, and **provenance** — which chat it came from, so "you told me that in another chat last month" is a checkable claim — plus supersession chains (what replaced what, and when).
- A saved memory owns its own copy of every photo. Deleting the original Clip cannot break the memory. You can preview, replace, or delete the memory's copy here without changing the original Clip.
- Awareness photos include a **Show this image every message** option. Batshit shows the approximate image-token cost and the count against the four-image limit before you leave it on. This is standing awareness, not a fresh upload on every turn; turning it off returns the image to normal recall-only behavior.
- Edit anything, move memories between lanes, or delete (with confirmation).
- The **Dreaming** log.
- The **Memory System** card: which embedding model powers memory search. The default is the built-in local model (no key needed). To use anything else, create a model preset for your embedding model in Settings → Models (set its Purpose to Utility — cloud like OpenAI or Google, or local like nomic-embed-text on Ollama), then just pick that preset here. Batshit detects the technical details (like vector dimensions) automatically when you save. Changing models requires an explicit **Re-Index** — Batshit walks you through it and refuses to run in a silently broken state.

## Privacy and limits, honestly

- **Memories are stored on your instance.** Memory search uses a local model by default. Memories and photos included in a chat go to the model you selected, including a hosted provider when you use one. If you configure an API embedding provider, memory text also goes to that provider for indexing.
- **The agent has no secret notebook.** Everything it stores is visible and editable in the Memory Panel. (A "private reflections" mode is a possible future idea — if it ever ships, it will be explicit and opt-in.)
- **Memory is per-agent.** Agents don't share memories. Deleting an agent deletes its memories; deleting a session keeps agent memories but marks their origin as deleted.
- **Backups include memory.** [Backup and restore](../admin/backup-and-restore.md) covers memories, their owned photos, graduated episodes, and settings; the search index rebuilds automatically after a restore.
- **Group chats don't do memory recall yet.** Agents can still save memories in groups, but automatic remembering is single-agent chats only for now.
- **Memory photos are local owned copies.** A Clip is only the input used when the memory is saved; Batshit makes a bounded copy and the memory never depends on that Clip afterward. Missing or damaged owned files fail loudly instead of silently dropping the photo.
- **Instant photo recall needs vision support.** Supported API models and Codex CLI can receive up to four images per recall call during the same reply. Claude CLI uses the next-message path. The recall result tells the agent which photos arrived and which were deferred, with a reason; a missing source is identified as unavailable. Recalled photos can remain available on later messages while the memory lingers, but the in-turn image bytes are not added to saved tool history. Text-only models cannot see photos.
- **Standing Awareness photos have a real token cost.** Their bytes are kept in the model's stable prompt prefix so supported providers can reuse them from cache, but each model/provider accounts for images differently. The Memory Panel estimate is per model call: a reply with several tool steps may send the same image more than once. Treat the estimate as guidance and the Execution Viewer as the truth for a specific run.
- **Models are imperfect.** Some models under-save ("I'll keep that in mind" — without actually saving). If it matters, say "save that as a memory" — and check for the chip.

## Troubleshooting

- **"Memory search index is not ready" or similar loud errors** — open Settings → Memory and run **Re-Index**. This rebuilds the search index from your stored memories (originals are never at risk).
- **Nap fails asking for a compact model preset** — that's the Claude `CLI` requirement above. Pick an API-compatible preset in Auto Compact settings or the Agent Memory card.
- **First memory save is slow** — enable memory from Agent Settings first; the toggle pre-downloads the model with a progress bar so saves are instant afterward.
- **A trigger didn't fire** — check the memory's trigger words in the Memory Panel (matching is whole-word), and note that superseded or expired memories deliberately never auto-fire.
- **The agent claims it did something (closed an episode, saved a memory) but nothing shows** — trust the visible records (chips, session menu episode line, Memory Panel) over the words, and ask it to actually call the tool. The records exist precisely so overclaiming can't hide.

## Related docs

- [The Sessions sidebar](sessions-sidebar.md)
- [Compact and Trim](compact-and-trim.md)
- [Execution Viewer](execution-viewer.md)
- [Clips](../clips/overview.md)
- [Backup and restore](../admin/backup-and-restore.md)
