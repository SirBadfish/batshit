# Batshit Official n8n Workflow Templates

These are public-safe n8n Workflow Subagent templates for Batshit. They intentionally omit n8n credential IDs, secret values, source-instance ownership metadata, version metadata, and private local URLs.

## Templates

| File | Use |
| --- | --- |
| `batshit-n8n-workflow-subagent.json` | Host/local n8n Workflow Subagent for `API` and `CLI` Primary Agents. |
| `batshit-docker-n8n-workflow-subagent.json` | Docker-flavored Workflow Subagent for Batshit's optional Docker n8n profile. |
| `batshit-n8n-wake-agent-on-schedule.json` | Wake-up webhook caller: a timed n8n workflow that starts a chat for one Batshit agent. For time-only triggers, Batshit's built-in Schedules need no n8n at all. |

## Import and configure

Import the matching template through the n8n UI. Advanced users can also use `n8n import:workflow`; the templates include workflow-level IDs and were validated with n8n `2.22.1` CLI import in a clean disposable profile.

Configure these pieces manually:

- Provider credentials for the model node.
- Redis credentials if you use the included memory node.
- The Batshit Subagent Tools URL reachable from n8n.
- The production webhook URL saved in the matching Batshit Subagent.

Current templates use Batshit's short-lived `batshit_native_tool_token` payload value and send it as `x-batshit-native-tool-token`; no saved Header Auth credential is needed.

URL defaults:

- Host/local template: payload `batshit_frontend_url`, then `BATSHIT_FRONTEND_URL`, then `http://127.0.0.1:5620`.
- Docker template: the same priority, with `http://app:3000` as its fallback.

Source-checkout Batshit should set `BATSHIT_FRONTEND_URL=http://127.0.0.1:5621`.

## Payload contract

Workflow Subagents read Batshit's current payload fields:

- `user_id`
- `session_id`
- `message_id`
- `subagent_id`
- `subagent_slug`
- `subagent_thread_id`
- `parent_agent_id`
- `primary_agent_type`
- `subagentPrompts`
- `batshit_native_tool_token`
- `batshit_frontend_url`

Do not remove `parent_agent_id` or change `actor_type: subagent` in the tool context. Batshit uses those fields to resolve the parent-scoped permissions for the Subagent.

Batshit treats slugs as exact user-owned names. It refuses collisions instead of silently adding a suffix.

After the workflow is configured and active, create an `n8n Workflow Subagent` in Batshit, paste the Production webhook URL, and assign it to an `API` or `CLI` Primary Agent.

Batshit does not copy provider API keys into n8n. Keep n8n workflow credentials in n8n.

## Conversation threads

Batshit sends a `subagent_thread_id` with each Workflow Subagent call. A fresh call creates a new id; a resumed call reuses the current id for that Subagent in the chat. Both templates append it to the Redis Chat Memory session key:

```text
subagent_sessions:<session_id>:subagent:<subagent_slug>:<subagent_thread_id>
```

Keep the included seven-day `sessionTTL`. When a fresh call changes the id, the old n8n conversation is no longer used and expires after that time. Batshit backs up its current thread id, but it does not copy conversations stored in external n8n Redis.

If you imported a template before thread control was added, re-import the current template and configure its credentials, or update the existing Redis Chat Memory node's key to include `subagent_thread_id` and set `sessionTTL` to `604800`. Updating Batshit alone does not edit an already-imported n8n workflow. A workflow that ignores the id may keep answering, but a fresh call will not reset its conversation.

---

## Waking an agent on a schedule

> **Batshit has its own clock now.** For a trigger that is only *time* — "every day at 9am",
> "every 30 minutes", "Tuesdays and Thursdays at 4pm" — use **Settings -> Admin -> Agent
> Wake-ups -> Schedules** instead. It needs no n8n, no webhook, and no token, and it adds a
> missed-run dialog for the times Batshit was closed. Use n8n when the trigger lives
> **outside** Batshit — a Slack message, a new video, an email, a finished build — or when
> the flow has outside steps before it reaches Batshit. This template stays supported for
> people who already run their automations in n8n and want everything in one place.

`batshit-n8n-wake-agent-on-schedule.json` is the other direction: instead of Batshit calling
n8n, n8n calls Batshit and asks an agent to start working. Use it for a morning check-in, a
nightly report, or anything else that should happen on a clock.

It has three nodes: a Schedule Trigger set to 9:00 am, a **Configure** node holding the three
things you edit, and one HTTP Request that calls Batshit.

### Set it up

1. In Batshit, open **Settings -> Admin -> Agent Wake-ups -> Wake-up Webhooks** and choose
   **New Webhook**. Pick the agent it should write to, then copy the token. **It is shown once**
   and is never stored, so if you lose it, use **Rotate** for a new one.
2. Import the template into n8n.
3. In n8n, create a **Header Auth** credential: name `Authorization`, value `Bearer <your token>`.
   Select it on the **Wake the Batshit Agent** node. Keeping the token in a credential instead of
   in the workflow means an exported workflow carries no secret.
4. Open the **Configure** node and set `wake_hook_id` to the webhook's id, and `message` to what
   the agent should be asked. Adjust `batshit_base_url` if your Batshit is not on the default port.
5. Change the Schedule Trigger to whatever time you want, then activate the workflow.

### Use `127.0.0.1`, not `localhost`

Node resolves `localhost` to IPv6 `::1` first, and Batshit listens on IPv4, so a URL of
`http://localhost:5620` fails with *"The service refused the connection - perhaps it is offline"*
even though Batshit is running. The template already defaults to `127.0.0.1`. Keep it that way.

URL by install:

- Mac app: `http://127.0.0.1:5620`
- Source checkout: `http://127.0.0.1:5621`
- Docker, called from Docker n8n: use the app service URL, `http://app:3000` (Compose service DNS,
  not `localhost`, which inside a container means that container).

### What the call does

The request body is small. Everything but `message` is optional:

```json
{
  "message": "Check my open DMs and tell me what needs attention today.",
  "kind": "info",
  "deliver": "wake"
}
```

- `deliver: "wake"` asks Batshit to start a chat now. `deliver: "wait"` leaves the message in that
  agent's inbox for its next turn. Leave it out to use the webhook's own default.
- `kind: "info"` is a note. `kind: "assignment"` is work to be finished and reported on; only an
  assignment can carry a `callback_url`.
- A successful call answers `202` with the DM id and, when a chat started, its session id.

Batshit refuses a wake for honest reasons and says which: wake-ups turned off, the agent already
mid-task, an hourly limit reached. **A refused wake still answers `202`** with
`delivered_as: "wait"` and a reason, so the message is never lost and the n8n run stays green —
the note is simply waiting in that agent's inbox instead of starting a chat.

A refused *call* is different and **fails the n8n execution on purpose**: a revoked or paused
token answers `403`, an hourly limit answers `429`, and a bad body answers `400`. A schedule is
something nobody watches, so a token that stopped working has to turn the run red rather than
succeed quietly every morning with the error hidden inside the output.

### Wait for the answer (the callback variant)

To have n8n receive the result instead of just firing and forgetting, send an assignment with a
`callback_url`:

```json
{
  "message": "Run the release checks and tell me what failed.",
  "kind": "assignment",
  "requested_outcome": "Pass or fail, plus what failed.",
  "scope": "Only the release checks.",
  "callback_url": "http://127.0.0.1:5678/webhook/batshit-result",
  "deliver": "wake"
}
```

Add a second **Webhook** node in n8n at that path. When the agent closes the item, Batshit POSTs
once:

```json
{
  "dm_id": "dm_...",
  "status": "done",
  "result": "The agent's own words.",
  "agent": { "id": "...", "name": "..." },
  "completed_at": "2026-09-07T11:28:53.861Z"
}
```

It fires **once**, waits ten seconds, and never retries; what happened is recorded on the DM. If
you want one workflow to block until the answer arrives, use n8n's **Wait** node in *On webhook
call* mode and pass its resume URL as `callback_url`.

### Limits worth knowing

- Each webhook may be called **30 times an hour**. Over that, Batshit answers `429` with a
  `Retry-After` header.
- The same message sent to the same agent twice within **10 minutes** is refused as a duplicate, so
  a mistakenly fast schedule cannot fill an inbox with copies. A daily or hourly schedule is well
  clear of this.
- An agent can be woken **6 times an hour**, and the whole instance **20 times an hour**.
- The recipient needs **Agent DMs** turned on in Agent Settings. A webhook writes a DM, and an agent
  with DMs off has no inbox to see it in.
- **Settings -> Admin -> Agent Wake-ups -> Allow Wake-ups** turns every wake-up off at once.

Validated on n8n `2.35.4`: imported through the public API, activated, and run against a live
Batshit instance, which created the chat and answered in it.

Full detail on wake-ups, webhooks, and the inbox is in
[Agent DMs and wake-ups](../../primary-agents/agent-dms-and-wake-ups.md).
