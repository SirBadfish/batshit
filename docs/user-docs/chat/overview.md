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

## Steer or Queue while the agent is busy

You thought of something after you hit send. You don't have to wait, and you don't have to start over.

While an agent is replying, two small buttons appear beside **Stop**: **Steer** and **Queue**. They are your two choices, and whichever one plain Enter will do is filled in so you can see it without hovering over anything.

- **Steer** hands your message to the agent *now*. It waits for the agent to finish whatever tool it's in the middle of, then arrives **inside the reply it's already writing** — the agent reads it and adjusts without losing its place. It shows up in the chat as a small bubble tucked into the reply, at the exact spot it arrived, marked *You, mid-reply*.
- **Queue** holds your message and sends it **the moment the reply ends**, as the next thing you say. Queue works for every message, including ones with files.

Click either button to send that way. Or press **Enter** for your default and **Cmd+Enter** (Ctrl+Enter on Windows) for the other one.

**Several queued messages go together.** If you queue two or three things while one long reply runs, they arrive as a single next message, in the order you sent them — not as three separate turns.

**There is no "interrupt and send".** If you want the reply to stop and your message to start fresh, press **Stop**, then **Enter**. That's two deliberate steps instead of a mode you could pick by accident. Stop always stops.

**Picking which one Enter does.** Settings → User → Chat → **When You Send While the Agent Is Busy**, which offers **Steer (default)** and **Queue**. The change takes effect immediately, even in a chat that's mid-reply.

### Files

**A message with a file always queues.** A Clip or an `@file` mention can't be handed to an agent in the middle of a reply, so pressing Enter with something attached queues the message whatever your default is. That's on purpose: "send it now" would have quietly meant "send it without the thing I attached".

**Steer never throws a file away.** If you press the Steer button (or Cmd+Enter) with a Clip attached, the words go now and **the Clip stays in the box** for your next message. The note beside the button says so before you click.

**An `@file` mention can't steer at all.** Unlike a Clip, the path is written into the text you're sending, so it can't stay behind. Steer is greyed out and the reason is printed beside it — that message can only queue.

### What the bubble tells you

A message that is in between — sent, but not yet part of anything — draws its own small bubble. It says one of these:

| It says | It means |
|---|---|
| *Queued for the agent's next step* | You steered. Batshit has your message and is holding it for the next tool call to finish. On a Codex or Claude agent this can sit for several seconds — that's normal, not a failure. |
| *Queued — sends after this reply* | You queued. It goes as your next message the moment the reply ends, attachment and all. |
| *Waits for your answer to the approval card.* | You queued it, and the reply then stopped at an approval card. It goes after your answer (see [When the reply stops at an approval card](#when-the-reply-stops-at-an-approval-card)). **Send now** sends it without waiting. |
| *Not sent — you stopped the reply* | You pressed Stop, and Stop means stop: your message was not passed on and no new turn started. This covers a queued message too. |
| *Not sent — the reply ended before it could land. Send it again.* | The rare backstop: the chat went quiet with your message still waiting, so Batshit never placed it anywhere rather than guess. |
| *Not sent — the approval card is still waiting for your answer. Send it when you are ready.* | A queued message waited 15 minutes for your answer to an approval card and stopped waiting. Your message is at the end of the chat, unanswered. |
| *Not sent — the approval card expired* | The card expired before you answered it, so your queued message was not sent. It is at the end of the chat, unanswered. |

Either way the bubble goes grey and **keeps your words on screen**, so a message that wasn't sent is still there. It is never quietly turned into a message you didn't mean to send.

**You don't have to retype it.** A grey bubble carries two small buttons: **Send now** sends that message exactly as you wrote it, attachment and all, and **Dismiss** clears the bubble away. Nothing is put back into the message box, on purpose: if you spent the wait typing something else, a receipt should not overwrite it. (After a reload the bubble keeps your words but loses **Send now**, because Batshit will not guess at a message it can no longer send exactly.)

A bubble disappears the moment your message has a real home. If the agent read it mid-reply, it becomes the inset inside that reply, marked *You, mid-reply*. If the reply ended first, it becomes an ordinary message from you, and the agent answers it.

A **grey "not sent" bubble** has no home to go to, so it stays until you are done with it: it clears the next time you send in that chat, and it clears when you leave the chat. Pressing **Send now** or **Dismiss** on one receipt leaves the others alone. A bubble for a reply that is still running stays put — leaving and coming back does not throw away the only sign that your message is still waiting.

### When the reply stops at an approval card

A reply that stops to ask for your **Approve** has not ended: it is waiting for you. So is anything you typed while it ran. A steer that did not reach the agent before the card, and every queued message, becomes one message from you at the end of the chat, marked *Waits for your answer to the approval card.* The agent does not answer it yet, so it never works on your words beside a card you have not answered.

In a one-agent chat, Compact waits for a visible approval card too, so the card's buttons and your waiting message stay visible. Auto Compact can run again once the card is answered or its expiry is recorded and the chat is idle.

- **Press Approve or Deny.** The reply carries on. When it finishes, the agent answers your message straight away, in its next reply, whether or not a Batshit tab is open. If the reply stops at another card, your message keeps waiting for that one too.
- **Press Send now** under the message if you do not want to wait. It goes as an ordinary message, and the card stays as it is.
- **Send a new message instead**, and the agent reads both, in order. The waiting one does not need a reply of its own.
- **Press Stop** on the reply that carries on after your click, and Stop means stop: your message is not sent. It says *Not sent — you stopped the reply*, with **Send now**. If that reply fails instead, your message says *Not sent — the reply ended before it could land. Send it again.*, with **Send now**.

Nothing runs while you are away: your words wait with the card. A card raised by an API agent expires after three minutes. When a chat tab shows an expired card, Batshit closes it as a Deny and the reply says the action did not run.

A card raised by a **Claude Code agent** waits ten minutes, whether or not a Batshit tab shows the chat. Close the tab, reload it, or open the chat later from another tab, and the card is there, with its buttons, until its ten minutes are up. If nobody answers in time, the card says *Expired: nobody answered*, the action does not run, and the agent is told why, so its reply can say what it needed. A card whose reply was stopped before anyone answered says *Expired: the reply ended*, and one whose answer Batshit could not read says *Ended: the answer could not be read* (the action did not run; ask again). Only your own click lets the agent answer your waiting message, so an expired card does not: your message says *Not sent — the approval card expired*, and **Send now** sends it.

A queued message with a file (or one in a group chat, or on an agent that cannot take a steer) waits for the same click. It shows *Waits for your answer to the approval card.* in every tab, and goes after the reply that carries on, whether or not a Batshit tab is open. **Send now** under it sends it without waiting, and so does sending a new message: both go, in the order you sent them. If you still have not answered the card after 15 minutes, it stops waiting: your message moves to the end of the chat, unanswered, and the tab you sent it from shows *Not sent — the approval card is still waiting for your answer. Send it when you are ready.*, with **Send now**. Words you typed or steered while the reply ran keep waiting for the card: they still say *Waits for your answer to the approval card.*, and your answer sends them. The message that stopped waiting goes when you press its **Send now**. If the card expires first, your queued message says *Not sent — the approval card expired* instead.

### The limits

**Nothing you type is lost.** A steer the agent never got to — a plain text answer, or one that's already wrapping up — is sent as your next message the moment the reply ends, the same as a queued one. If the reply stopped at an approval card, it waits for your click first (above). Queued messages are held **on the server**, so they still arrive even if you reload the page or close the tab.

**Messages with files wait in line.** A queued message with a Clip or an `@file` (and any queued message in a group chat, or on an agent that cannot take a steer) is saved the moment you send it and waits on the server for the reply to end. It shows as *Queued — sends after this reply* in every tab and window, and it goes with its attachment and its files, with or without a tab open. Five can wait like this in one chat; a sixth is refused, and its words land at the end of the chat, unanswered.

**Five at a time, per reply.** Steered and server-queued messages share one allowance of five per reply. The sixth is refused with *"5 messages are already waiting for this reply (Batshit holds 5). Wait for the reply to finish."* A message the agent has already read frees its slot, so a long tool-heavy reply never locks you out.

**A message from another tab waits its turn.** A reply can start in one tab or window while you type in another, and for its first moments the other tab cannot know it is running. A message you send from that tab is not refused: Batshit holds it and sends it the moment the chat is free. Until then every tab shows it as *Queued — sends after this reply*, and it appears in the chat after that reply, where a new message would. Five can wait like this at a time; a sixth is refused, and its words land at the end of the chat, unanswered. **Stop** stops these too: none of them is sent, each one moves to the end of the chat, unanswered, and the tab you sent it from shows *Not sent — you stopped the reply* with **Send now**.

**When Batshit says no.** If it refuses without the reply ending — the cap above, an agent DM already waiting, or a moment when it can't reach the server — you get a one-line note saying why. The reply keeps running, nothing is interrupted, and nothing is sent. Your words stay in the box.

**Where steering isn't available.** Group chats can't be steered, because agents there speak one at a time. Neither can Codex agents running on the one-shot transport, or CLI agents using your own profile rather than Batshit's. In all of those the Steer button is greyed out, the reason is printed beside it, and **Queue still works** — your message waits and goes when the reply ends.

**Voice.** Neither steering nor queuing stops the agent talking, because the reply is still going. Only Stop does that.

## The message stream

Above the composer is the conversation itself — your messages and the agent's replies, newest at the bottom. Replies stream in live as the model generates them.

A few things you'll notice that aren't in ordinary chat apps:

- **Tool cards.** When an agent runs a tool — a file read, a command, a web search, an n8n workflow — the result renders as a card inline, not as a wall of raw text.
- **Zip badges.** Large output (long logs, big tool results, generated images) gets compressed into a Zip so it doesn't flood the chat or burn context. The full content stays one click away. This is a Batshit-original idea — the concept is explained in [Zips and context](../tools/zips.md), and the chat-side controls are in the [Zip Manager](zip-manager.md) section.
- **Outside pictures wait for your click.** A picture in an assistant reply that comes from another website shows as a box naming the website; nothing is fetched until you click **Load picture**. Batshit may explain whether it saw the exact address in information it could account as read. A matching address still needs your click and does not prove the agent chose it safely. A reply still being written, a failed record read or write, or a record that does not match the exact reply stays in “Checking where this address came from” with no Load action. Batshit blocks an address when only its start was read, when an unread address may contain chat text, or when a complete API record shows it was not read. An exact address that was read but may contain chat text gets a warning and a smaller Load action. Managed Codex and Claude replies can remain unknown because Batshit cannot see all vendor context or truncation, though partial evidence can still block an address. If Batshit cannot tell and the reply is not pending, it shows a warning and a smaller Load action. Older replies and direct LiveKit voice replies have no address record; after Batshit reads the chat's records, they appear as unknown with a warning and a smaller Load action. These labels apply to pictures in assistant reply text. Tool-card and expanded Zip/Clip pictures follow the source rules: a Clip Batshit supplies for the message shows at once, even when its URL uses a tunnel; uploads served from Batshit's own address also show at once, while other tunnel or website pictures wait for your click (including Agent Browser screenshots). An outside request can send its address to that website, including data in its path or query. A click loads only that address in that message and browser tab; a reload or another tab asks again.
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

Every model has a context window — a hard limit on how much conversation and tool output it can "hold in mind" at once. Batshit shows how full it's getting right under the composer, in the **Token Panel**, so you see trouble before something breaks.

The Token Panel shows:

- **A context meter** — a ring that fills up as the window fills, with the percent used. It shifts color as you approach the limit (calm when there's plenty of room, a warning tone in the high range, and a clear danger state near full), so you can see trouble coming.
- For Codex and Claude Code agents, the meter uses the chosen CLI model's known window, then the window reported by a matching run when available. A Codex agent with custom CLI overrides outside the numeric context settings does not reuse a saved runtime report on later views, but live previews still update its count and limit. Changing its model or settings invalidates an older preview. Claude's configured context cap applies before the first preview. If the limit is unknown, it still shows the tokens used but leaves the percentage blank and explains why.
- **A running cost indicator** for the chat. Tokens the provider read from its cache cost the cached price. Tokens it wrote to its cache can cost more than plain input: on Claude models a write costs 1.25 times the input price for Anthropic's 5-minute cache and 2 times for its 1-hour cache, and the running cost counts them that way. When Batshit does not know a provider's cache-write price, the running cost is marked as an estimate.
- **Tokens used and remaining**, on hover.
- **A cache readout** — how much of the latest response's input the provider read from its prompt cache, as a percent (cached input is billed far cheaper on most providers). Hover for the token math, tokens newly written to cache, and the whole chat's overall rate across every response that reported cache data.
- If Batshit cannot read a saved CLI context report, the send can continue, but the context limit and percentage stay unknown. The Token Panel details explain the failure while the used-token count remains visible. A newer successful check or matching runtime report clears the warning.
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
