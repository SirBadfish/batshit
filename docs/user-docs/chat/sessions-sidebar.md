# The Sessions sidebar

Every conversation in Batshit is a Session — a saved chat with its own history, its own agent, and its own place in the sidebar. The Sessions sidebar is where you create chats, jump between them, organize them into folders, and protect the ones you don't want to lose.

A Session isn't a fragile browser tab that vanishes when you close it. It's saved to your Batshit instance and waits for you to come back, with the full transcript intact.

## What a Session is

A Session is one chat thread. When you start a new chat, Batshit creates a Session behind it: a record that holds the messages, remembers which agent handled it, and keeps any Zips, Clips, and context state tied to that conversation.

Because the Session is the durable unit, you can:

- Close Batshit and reopen a chat exactly where you left it.
- Run several chats and switch between them without losing any.
- Keep a long-running task in one Session while you start something unrelated in another.

Sessions are stored locally on your own instance — there's no cloud account holding your chats. (Batshit is single-user per instance, so "your sessions" means the ones on the instance you're running.)

## Creating and naming chats

Start a new chat with the **New Chat** action at the top of the sidebar. Batshit also creates a Session automatically if you just start typing and send when no valid chat is selected, so you never end up typing into nothing.

Each Session has two names worth knowing about:

- A **Session ID** — a short identifier Batshit generates for you. You can rename the ID, but only *before* the conversation has any messages. Once a chat has started, the ID is locked so existing history can't be quietly re-pointed. (This is a safety rule, not a limitation you'll usually bump into.)
- A **title** — the friendly name shown in the sidebar. You can rename the title any time, even mid-conversation, as often as you like.

The practical takeaway: rename the *title* whenever you want a chat to be easy to find. The ID is mostly plumbing.

## Folders

When you accumulate chats, folders keep them sorted. You can create folders in the sidebar and file Sessions into them — a folder per project, per topic, per client, however you think.

A few things to know:

- There's always a **default folder**, and it can't be deleted. Chats that aren't filed anywhere live there.
- Folders sort by recent activity, so the chats you're actually using float toward the top.
- Deleting a folder gives you a choice: **delete the folder only** (its chats move back to the default folder, nothing is lost) or **delete the folder and its chats** (the chats are permanently removed). Batshit asks which one you mean — it never guesses.

## Locking a Session

Some chats you really don't want to delete by accident — a reference conversation, a hard-won debugging thread, a setup you'll reuse. Lock it.

Locking a Session protects it from deletion. While a chat is locked:

- You can't delete it until you unlock it, and the delete control tells you so.
- It's protected even from bulk cleanup — if you delete a whole folder's chats, a locked chat in that folder stops the operation rather than getting swept up.

Locking is enforced in several places at once, so an accidental delete path can't slip past it. What locking does *not* do is protect against deliberate infrastructure-level wipes (for example, clearing the underlying data store directly). For real recovery insurance, use [Backup and restore](../admin/backup-and-restore.md) and keep your own backups.

## Search and persistence

The sidebar includes search so you can find a chat by name without scrolling. If a chat is running in the background — say a long `API` or `CLI` task you started, then switched away from — its row shows a status label so you can see it's still working.

Because Sessions persist to your instance, your chat history survives reloads and restarts. If you ever switch a Session's selected agent and reopen the chat later, Batshit reselects the agent that last handled it (unless you change it yourself).

## Viewing a chat as Markdown

The Session menu includes **View Chat as Markdown** — a clean, read-only transcript of the whole conversation, with Zips and Clips resolved into readable text. It's handy for copying a conversation out, sharing it, or archiving it. Note that this is the *human* transcript, not an execution trace; to see exactly what a model received on a given turn, use the [Execution Viewer](execution-viewer.md) instead.

## Related docs

- [The chat workspace](overview.md)
- [Backup and restore](../admin/backup-and-restore.md)
- [Execution Viewer](execution-viewer.md)
- [Primary Agents](../primary-agents/overview.md)
- [Group Chat](../groups/overview.md)
