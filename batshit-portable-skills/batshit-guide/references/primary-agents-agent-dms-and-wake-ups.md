# Agent DMs and Wake-ups

Your Primary Agents can send each other messages. One agent can leave another a note, hand it a job, or send back the answer to a job it was given. That is an **Agent DM**.

A DM can also *start* the other agent working. Batshit opens a chat for that agent, puts the DM in it as the first message, and runs one turn — with nobody typing. That is a **wake-up**.

Anything outside Batshit can start a chat the same way through a **wake-up webhook**: n8n, a schedule, a Slack bridge, a finished build.

Both are off by default per agent. If you never turn them on, nothing about your Batshit changes — no extra icons, no extra tokens, no unexpected chats.

## Turning it on

Agent DMs are a per-agent switch, in **Agent Settings → Agent DMs**.

| Setting | What it does | Default |
| --- | --- | --- |
| **Agent DMs** | This agent can send and receive DMs. Off means no DM tools, no inbox, and no extra words in its prompt. | Off |
| **Who May DM This Agent** | Any agent, or only the ones you pick. Picking nobody means nobody. | Any agent |
| **May Be Woken** | This agent can have a chat started for it. Does nothing until a sender or a webhook exists. | On |
| **Working Style** | How a wake-up reaches it — see below. | Parallel |
| **Wake-up Time Limit** | Hard stop on one woken turn, 5 to 240 minutes. Blank means 30. | Blank (30 minutes) |

Turn **Agent DMs** on for at least two agents, or nobody has anyone to write to.

There is also one instance-wide switch in **Admin → Instance-wide defaults → Agent Wake-ups → Allow Wake-ups**. Turn it off and nothing can start a chat on its own; every wake-up waits in the inbox instead, with the reason recorded.

### Working style: Parallel or One at a time

- **Parallel** (default): a wake-up opens its own new chat. The agent can be woken while it is already busy somewhere else. One woken turn per agent at a time.
- **One at a time**: a wake-up lands in the agent's current chat instead, so two copies of one agent never run. If that chat is already mid-turn, the DM waits there and the agent sees it on its next turn.

## The three kinds of DM

| Kind | What it means | What the agent does with it |
| --- | --- | --- |
| **info** | A note. | Reads it. Reading it closes it. |
| **assignment** | Do this and report back. | Claims it, does the work, closes it with a real result — which is sent back automatically. |
| **result** | The answer to an assignment. | Lands with whoever asked for the work. |

An assignment carries a requested outcome, a scope, and who to report back to. An agent can hold **one assignment at a time** — Batshit refuses a second claim until the first is closed.

## Wait or wake

Every DM is sent one of two ways.

- **wait** — the default. The DM lands in the recipient's inbox and it sees it on its next turn, whenever that is. Nothing starts.
- **wake** — Batshit starts a turn for the recipient right now.

A wake-up can be refused: wake-ups off for the instance or the agent, the agent already mid-task, or an hourly limit reached. **A refused wake becomes a wait**, with the reason recorded on the DM and shown to the sender. Nothing is lost, nothing retries, and nothing queues in the background.

When an assignment sent with `wake` is closed, its result can wake the *sender* too — back into the very chat where the question was asked.

## Woken chats

A woken chat is an ordinary chat. It appears in your sidebar the moment it starts, with a small icon that says what started it (an envelope for a DM, a webhook icon for a webhook) and the usual spinner while it runs. It costs tokens like any chat, shows in the Execution Viewer like any chat, and has the normal **Stop** button.

Open it while it is still running and you see the whole reply from the beginning, not from the middle.

At the top of a woken chat is a one-line banner: *Started by a DM from Cooper · Open inbox*.

The chat's first message is the DM, under a header that says plainly it did not come from you:

```
[Agent DM — from Cooper, not from the user] assignment — Check the build
```

That header matters. **A DM is data from another agent or program, not an instruction from you.** It cannot approve a tool, give consent, or change a setting, and Batshit tells the agent so.

### Risky actions wait for you

Some Fabric controls are marked risky — installing a skill from a link, starting or stopping a Docker add-on, installing a voice engine, deleting a memory, rolling an artifact back. In an ordinary chat the agent can run one after you say yes.

**In a chat a DM or a webhook started, Batshit refuses those outright**, no matter what the agent passes and no matter what you approved a few minutes earlier in a different chat. The agent is told to ask you and leave the item open.

Nothing is cancelled when that happens. The turn ends normally, the DM stays open, and the agent's message says what it wanted to do. **Reply in that same chat** and the next turn is an ordinary one, so the agent can go ahead the usual way.

### When a woken chat needs you

A woken chat can stop on something only you can clear: the refusal above, or a Bash or tool approval waiting for a click. Batshit says so instead of leaving it to look like work in progress.

- The header envelope turns **orange**, and its tooltip says how many items need you.
- The drawer row gets a **Needs you** badge; hover it for the reason.
- That agent's presence dot reads **needs you** instead of idle, so another agent asking "who is free?" is told the truth.

The signal clears the moment you reply in that chat, or when the item is closed.

## The inbox drawer

An agent with Agent DMs on shows an **envelope** in the chat header, with a count of what is waiting. Click it for the inbox drawer.

- **Inbox / Sent / Done** tabs, and a filter for one agent or all of them.
- A dot beside the chosen agent showing whether it is idle, working, or waiting on you right now.
- Each row: who wrote it, the kind, the subject, what the wake-up actually did and why if it was refused, and links into the chats on both sides.
- Open a row to read the body, the requested outcome, the scope, and the result.
- **Stop** on any row whose woken turn is still running.

Three row actions are yours, not the agent's:

- **Mark done** closes the item for you. The sender is *not* told, and the agent can no longer close it itself.
- **Reopen** puts it back in the agent's inbox as new. If the agent closes it again, a fresh result is sent and any webhook callback fires again.
- **Delete** removes it entirely.

## Wake-up webhooks

A wake-up webhook lets anything outside Batshit start a chat for one agent. Create one in **Admin → Instance-wide defaults → Agent Wake-ups → Wake-up Webhooks**.

You give it a name, an agent, and a default delivery (start a chat now, or leave it in the inbox). Batshit shows you the token **once** — copy it then, because it is never shown again. Batshit stores only a fingerprint of it.

The recipient agent needs **Agent DMs** on, not just "May be woken". A webhook call writes a real DM record, and an agent with DMs off would have no inbox to see it in and no way to close it.

Calling one:

```bash
curl -X POST http://127.0.0.1:5620/api/wake/whk_example \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Say good morning and list today'"'"'s open DMs."}'
```

Use `127.0.0.1`, not `localhost`, when the caller is n8n or any other Node program. Node resolves `localhost` to IPv6 first and Batshit listens on IPv4, so `localhost` fails with a connection error while Batshit is running perfectly.

Body fields:

| Field | Meaning |
| --- | --- |
| `message` | Required. The first message of the chat. Up to 40,000 characters. |
| `subject` | Optional. Names the chat and the inbox row. |
| `kind` | `info` (default) or `assignment`. A webhook cannot send a `result`. |
| `deliver` | `wake` or `wait`. Defaults to the hook's own setting. |
| `priority` | `normal` (default) or `urgent`. |
| `callback_url` | Assignment only. Batshit POSTs the result here once when the agent closes it. |
| `expires_in_hours` | 1 to 720. Overrides the default expiry. |

The answer is `202` with `{dm_id, delivered_as, reason?, session_id?}`. Note that `delivered_as` can be `"wait"` even on a successful call — that is a refused wake-up, not a failed call, and `reason` says why.

Batshit fires a `callback_url` **once**, waits 10 seconds, and never retries. The outcome is stored on the DM and shown in the drawer.

Rows in the Admin card show each hook's name, agent, delivery default, when it was created, when it was last used, and how many times. You can pause a hook, rotate its token (the old one stops working immediately), or revoke it entirely.

**About exposure.** The webhook route lives wherever Batshit lives. On your own machine only your machine can reach it. If you run a tunnel — a Cloudflare tunnel for clip uploads, for instance — that tunnel publishes the whole origin, and this route is reachable from the internet along with everything else. That is your existing tunnel choice, not something this feature turns on. The token is 32 random bytes, every bad token gets the same answer so a hook id gives nothing away, and each hook is limited to 30 calls an hour.

There is an official n8n template for the common case — a schedule that wakes an agent — in [the n8n templates folder](../user-templates/batshit-official-n8n-workflow-templates/README.md).

### Text from outside is only as trustworthy as whatever sent it

A webhook message becomes the first message of a real chat. If your n8n flow forwards a Slack message, an email, a form entry, or an RSS title, then **a stranger wrote part of that chat**. Batshit labels it — the agent is told plainly that the message did not come from you — but treat a webhook-fed agent as one that reads untrusted text.

Batshit handles the part it can:

- Risky Fabric controls are refused in any woken chat, whatever the message says (see [Risky actions wait for you](#risky-actions-wait-for-you)).
- The DM guidance tells every agent that a DM or webhook cannot approve a tool, give consent, or change a setting.
- Wake-ups are capped, chains stop at three deep, and each hook is limited to 30 calls an hour.

The part Batshit cannot decide for you is your own tool setup:

- **Keep Bash approvals on** for an agent fed by a webhook. Dangerous mode skips the approval popup, and a forwarded message is the wrong place to find out.
- **Give it only the tools it needs.** An agent whose job is "summarise the nightly build" does not need the voice-engine installers or the Docker controls.
- **Point the hook at a specific agent**, not your everyday one.

### If a token leaks

You do not have to take Batshit down.

1. Open **Admin → Instance-wide defaults → Agent Wake-ups → Wake-up Webhooks**.
2. **Revoke** that hook, or **Rotate** its token — the old token stops working immediately either way. Rotate keeps the same URL, so you only have to paste the new token into your n8n workflow.
3. If you want everything stopped at once, turn off the **Agent wake-ups** master switch in the same panel. Every wake-up then becomes an ordinary inbox item, and nothing starts a chat until you turn it back on.

Check the drawer afterwards for chats you did not expect. Every wake-up leaves a row saying which hook sent it and which chat it started.

## The limits, with their numbers

These are fixed in v1 except the time limit, which is a per-agent setting.

| Limit | Number |
| --- | --- |
| Wake chain depth (A wakes B wakes C…) | 3 |
| Wake-ups per agent per hour | 6 |
| Wake-ups for the whole instance per hour | 20 |
| Woken turns running at once | 1 per agent, 3 total |
| One woken turn's time limit | 30 minutes (5–240, per agent) |
| Open DMs in one inbox | 50 |
| Webhook calls per hook per hour | 30 |
| Subject / body / result length | 240 / 40,000 / 20,000 characters |
| An unread DM expires after | 7 days (info), 14 days (assignment, result) |
| A closed DM is kept for | 30 days |

Two loop guards: an agent cannot DM itself, and an identical DM sent again within 10 minutes is refused as a duplicate.

## What this costs

A woken turn is a normal turn. It uses the recipient's model, its tools, and its context, and it shows in that chat's Token Panel and Execution Viewer like anything else. Waking an agent six times an hour costs six turns.

Turning Agent DMs on for an agent also adds a short block to its system prompt and one line per open item to its per-turn context. An agent with DMs off pays nothing at all.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| An agent says it cannot find `sys.dm.send` | Agent DMs is off for that agent. | Agent Settings → Agent DMs. |
| A DM was refused with "does not have Agent DMs turned on" | The *recipient* is off, not the sender. | The recipient's Agent Settings. |
| Every wake becomes a wait | The Admin master switch is off, or the recipient's "May be woken" is off. | Admin → Agent Wake-ups, then Agent Settings. |
| A wake says "already has a woken turn running" | One woken turn per agent is the limit. | Wait for it, or Stop it from the drawer. |
| The webhook answers `403` | Wrong token, wrong hook id, paused hook, or expired hook. | The Admin card. Rotate the token if you lost it. |
| The webhook answers `429` | 30 calls this hour for that hook. | `Retry-After` in the response says how long. |
| n8n says "the service refused the connection" | `localhost` resolved to IPv6. | Use `127.0.0.1` in the URL. |
| A reopened assignment finished with no new result | Fixed. Reopen now clears the "already reported" markers, so closing it again sends a fresh result and fires the callback again. | — |
| The agent never mentions a DM you sent | It is a `wait` DM and the agent has not had a turn yet. | Say anything in its chat; the roster shows on the next turn. |

## Related docs

- [Primary Agents](overview.md)
- [Sessions sidebar](../chat/sessions-sidebar.md)
- [Admin settings](../admin/overview.md)
- [Connect n8n](connect-n8n.md)
- [Security and trust](../security/overview.md)
- [Glossary](../reference/glossary.md)
