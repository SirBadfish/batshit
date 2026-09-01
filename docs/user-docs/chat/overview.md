# The chat workspace

The chat workspace is where you actually talk to Batshit — type a message, pick which agent answers, watch it stream back, and reach for the tools around the edges when you need them. This page is the tour: what every part of the chat screen does and where to go to learn each piece in depth.

If you've used any AI chat app, the middle of the screen will feel familiar: you type at the bottom, the conversation scrolls above. What's different about Batshit lives in the controls *around* the conversation — an agent picker that can run a whole roundtable, a live context meter, and side panels for reusable files, compressed output, and the exact prompt an agent received. None of it is required to start. You can ignore all of it, type "hi," and get an answer.

## The composer

The composer is the bar at the bottom where you write. Type your message and press Send (or use the Send button). It grows as you type and accepts multiple lines.

Around the text box sit the controls you use most:

- **Attach files** — the Clips control lets you attach a saved file or image to your message, or upload a new one. Batshit calls these reusable attachments Clips. See the [Clips Manager](clips-manager.md) section below and the full [Clips](../clips/overview.md) concept page.
- **Voice** — a one-time microphone button captures a single spoken message, and a separate Voice Mode button starts continuous spoken conversation. Full details live in [Voice](../voice/overview.md).
- **The agent selector** — the picker in the middle that decides who answers. Covered in its own section below.
- **Tool and capability controls** — depending on the active agent, you'll see controls for MCP tools, the [Zip Manager](zip-manager.md), and the [Execution Viewer](execution-viewer.md). The [Token Panel](#the-token-panel-your-context-meter) below the bar carries the context controls.

When an agent is working, a **Stop** control appears so you can cut a run short. Stopping doesn't throw away what the agent already produced — partial work and tool results stay in the chat with a clear note. More on that in [Zips and context](../tools/zips.md).

## The message stream

Above the composer is the conversation itself — your messages and the agent's replies, newest at the bottom. Replies stream in live as the model generates them.

A few things you'll notice that aren't in ordinary chat apps:

- **Tool cards.** When an agent runs a tool — a file read, a command, a web search, an n8n workflow — the result renders as a card inline, not as a wall of raw text.
- **Zip badges.** Large output (long logs, big tool results, generated images) gets compressed into a Zip so it doesn't flood the chat or burn context. The full content stays one click away. This is a Batshit-original idea — the concept is explained in [Zips and context](../tools/zips.md), and the chat-side controls are in the [Zip Manager](zip-manager.md) section.
- **A Tool Results Summary.** After tool calls, an agent can leave a short, always-visible note so the useful facts survive even after a big result is zipped.

Batshit can also run more than one chat at once — a long task in one session keeps going while you work in another. The [Sessions sidebar](sessions-sidebar.md) shows a status label on any background chat that's still running.

## The agent selector and live agent state

This is the control that decides *who* you're talking to, and it's worth understanding because Batshit isn't limited to one assistant.

The selector sits in the middle of the composer row. It shows the current agent's name and a small badge for its type — `API` or `CLI`. Those are Batshit's two [Primary Agent](../primary-agents/overview.md) types: an `API` agent talks straight to a provider, and a `CLI` agent drives a coding CLI like Codex or Claude Code. n8n is not a Primary Agent type; it remains available through workflow tools and n8n Workflow Subagents. Open the selector to switch agents, and it lists your agents and any Groups you've built, plus shortcuts to create or manage them.

A few behaviors that matter:

- **One speaker per chat, but you can switch any time.** A single chat is handled by one agent at a time. Switch agents mid-conversation and the new one picks up the same thread. Batshit remembers which agent last handled a session and reselects it when you reopen that chat — though if you manually change agents after opening it, your choice stands.
- **Unavailable agents are shown honestly.** If an `API` or `CLI` agent cannot run because its provider, model, or CLI runtime is unavailable, it appears greyed out with the reason instead of silently failing when you hit Send. Retired n8n Primary Agent records can be deleted but cannot be selected for new sends.
- **Groups are a different mode.** Choosing a Group puts several agents in the same conversation with a single-speaker queue, so they take turns instead of talking over each other. A Group shows a "Group" badge in the selector. This is its own feature with its own page: [Group Chat](../groups/overview.md).

If an agent ever does something you didn't expect — ignores a file, says it can't see a Subagent — the [Execution Viewer](execution-viewer.md) shows you exactly what that agent was actually sent.

## The Token Panel: your context meter

Every model has a context window — a hard limit on how much conversation and tool output it can "hold in mind" at once. Most chat apps hide how full it's getting until something breaks. Batshit puts it right under the composer in the **Token Panel**.

The Token Panel shows:

- **A context meter** — a ring that fills up as the window fills, with the percent used. It shifts color as you approach the limit (calm when there's plenty of room, a warning tone in the high range, and a clear danger state near full), so you can see trouble coming.
- **A running cost indicator** for the chat.
- **Tokens used and remaining**, on hover.
- **A cache readout** — how much of the latest response's input the provider read from its prompt cache, as a percent (cached input is billed far cheaper on most providers). Hover for the token math, tokens newly written to cache, and the whole chat's overall rate across every response that reported cache data.
- **A speed readout** — output tokens per second for the latest response. Hover for time to first output and total model time. API agents show the AI SDK's own measurements; managed Codex and Claude CLI agents show timings Batshit measured live (first output includes CLI startup time).

Both readouts are honest by design: they only ever show numbers the provider or runtime actually reported or Batshit actually measured. When a lane doesn't report a metric, you see a dash — never a guess.

One honest caveat about the cache readout: a few providers report a small, constant cached number (for example, 128 or 144 tokens) on every response — even the very first one, when nothing could possibly have been reused. That's a quirk of how those providers count, not real savings. Treat a tiny cached percent that never changes as noise; real cache reuse shows up as a large share of the input that drops when you change the start of the conversation.

It also hosts the controls for taming a long conversation:

- **Trim** temporarily drops older messages from what gets *sent* to the model, without deleting anything from the visible chat. It's fully reversible.
- **Compact** permanently replaces a stretch of old context with one short summary the agent reads instead — useful when a conversation is too long to keep carrying in full.
- **The Execution Viewer launcher** opens the prompt-inspection sheet.

Trim and Compact are explained end to end, with the rules about what stays protected, in [Zips and context](../tools/zips.md). The dedicated page for these controls is [Compact and Trim](compact-and-trim.md).

## The surfaces around chat

The conversation is the center, but several panels frame it. Each has its own page — here's the map:

- **[Sessions sidebar](sessions-sidebar.md)** — your list of chats, with folders, search, renaming, and locking. Every conversation is a Session saved to your instance.
- **[Artifact zones](artifact-zones.md)** — published Artifacts (reusable mini-apps, forms, dashboards, generators) appear as a header icon, a side panel, or a dropdown widget right in the workspace. The deeper concept lives in [Artifacts](../artifacts/overview.md).
- **The Goon Dock** — Batshit's 3D avatars (Goons) appear in a dock beside the chat, lip-syncing and reacting to your agent. It's introduced and fully documented in [3D Goons](../goons/overview.md); this tour just points you there.
- **[Zip Manager](zip-manager.md)** — the panel for browsing and controlling every Zip in the current session.
- **[Clips Manager](clips-manager.md)** — the panel for browsing your saved Clips and attaching them to a message.
- **[Execution Viewer](execution-viewer.md)** — the read-only window into exactly what an agent was sent, what it sent back, and what the tokens cost.

## Related docs

- [Sessions sidebar](sessions-sidebar.md)
- [Memory & Infinite Sessions](memory-and-infinite-sessions.md)
- [Zips and context](../tools/zips.md)
- [Clips](../clips/overview.md)
- [Primary Agents](../primary-agents/overview.md)
- [Group Chat](../groups/overview.md)
- [3D Goons](../goons/overview.md)
- [Execution Viewer](execution-viewer.md)
