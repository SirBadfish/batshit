# Group Chat

Group Chat puts more than one AI agent in the same conversation — and unlike bolting several bots into one thread, they don't talk over each other. Batshit runs a single-speaker queue: one agent speaks at a time, each agent sees what the others already said, and the conversation reads like a real round-table instead of three voices shouting at once.

This is one of the parts of Batshit that works differently from anything you've used, so it's worth a minute to understand how speaking turns actually work.

## What Group Chat is for

Reach for a Group when a task benefits from more than one perspective or specialty in one place:

- A planner, a critic, and a builder hashing out an approach.
- Two agents with different models comparing answers in real time.
- A "panel" of personas reacting to the same prompt.
- A specialist that only chimes in when the topic is theirs.

If you just want one assistant that delegates to helpers behind the scenes, that's [Subagents](../subagents/overview.md), not Group Chat. Group Chat is for conversations you want to *watch* multiple agents have.

## Which agents can join

Group Chat uses `API` and `CLI` Primary Agents—the two live Primary Agent types.

Each agent in a Group keeps its own model, system prompt, personality, voice, and tool access. That's the point — a Group is a room full of *different* agents, not one agent wearing hats.

## How turns work

The single-speaker queue is the heart of it:

- One agent speaks at a time. Batshit never lets two responses stream over each other.
- Each agent sees the responses that came before it in the round, so replies build on each other instead of ignoring each other.
- After the round, the conversation can continue with follow-up turns so agents can actually respond to one another, not just answer you once.

You steer who talks. By default, speaker selection is flexible — Batshit picks a reasonable next speaker — but when you name a specific agent, that agent is the one who answers. Speak policies let you tune how eager each agent is to jump in versus waiting until it's directly addressed.

If you have [Judge Juice](../judge-juice/overview.md) set up, an agent can use **Judge Juice: Smart**. Batshit asks Jev who is best placed to reply and skips unnecessary follow-ups before they cost a model call. Smart agents can also skip a reply to your message when Jev clearly judges that no answer is needed. If all eligible agents are skipped, **Reply skipped by Jev** appears on your message with an explanation and an Execution Viewer entry; no agent runs. Naming any agent (including several) or using a driver still wins, and other presets keep their rules. Attachments, skills and other uninspected input prevent Judge Juice from skipping your turn; they do not guarantee an answer when no agent is eligible or a run fails. An uncertain or unavailable judgment uses the usual rules. If Batshit confirms the skip was refused, it follows the usual reply rules and says so. If it cannot confirm whether the skip was saved, the turn ends visibly without an agent run or automatic replay; the Execution Viewer shows what is known.

## Tool sharing

Agents in a Group can share tool results so the group stays on the same page. Shared tools are visible to the other agents; unshared tool output is summarized for everyone else rather than dumped in full. Set tool sharing intentionally — it's how you decide whether the group works from a common set of results or each agent keeps its own.

## Two things a Group does differently

Both come from the same fact: agents in a Group speak one at a time, and the room moves on to the next speaker.

**Sending while the group is busy queues.** In a one-on-one chat you can [steer](../chat/overview.md#steer-or-queue-while-the-agent-is-busy) — your message lands inside the reply the agent is already writing. A Group can't do that, because agents there speak one at a time, so the **Steer** button is greyed out with the reason beside it and **Queue** is what you get: your message waits and goes the moment the reply ends. To stop a group reply instead, press **Stop**.

**Risky actions can't be approved in a Group.** A [risky Fabric action](../fabric/overview.md#approving-a-risky-action) normally pauses and waits for your click on an **Approval required** card. In a Group, Batshit refuses it instead: *"Risky controls are not available in group chats. Ask the user in a direct chat with this agent."* A card raised here would be abandoned the moment the next agent starts speaking, and a half-answered approval is worse than a plain no. Open a direct chat with that agent, ask for the same thing, and approve it there. The same goes for a shell command or a skill script that would need your approval: in a Group the agent is told it cannot run it here, and no card appears. A command on the agent's allow list still runs.

## Voice in a Group

Group Chat supports Voice. Batshit queues playback by agent, so spoken replies don't collide — each agent finishes speaking before the next begins, the same way the text queue works. Each agent can use its own voice settings.

## Goons in a Group

Group Chat uses one visible Goon at a time in the Goon Dock or Mac Desktop Mode. Batshit follows the same single-speaker order as the conversation: the agent whose voice is audibly playing wins first, then the current streaming speaker. While the group is idle, a valid configured Group driver is the visual fallback, followed by the current agent.

The Goon changes when the active speaker changes; Batshit does not render the whole group at once. If that agent has no ready Goon assigned, there is no avatar to show for that speaker. Voice remains independently queued by agent, so the visual change never creates overlapping audio.

## Setting up a Group

1. Create the `API` or `CLI` Primary Agents you want in the room, and confirm each one works on its own first.
2. Create a Group and add those agents.
3. Set speak policies if you want some agents to hold back until addressed.
4. Set tool sharing the way you want the group to collaborate.
5. Send a message — address the whole group, or name a specific agent to make it the speaker.

Get each agent working solo before grouping them. A Group can only be as healthy as its members: if one agent's model or tools are broken alone, it'll be broken in the Group too.

## Changing or deleting a Group

Group settings save automatically. Wait for the save to finish before deleting the Group; deletion refuses unsaved or pending changes. If Batshit reports that a change was not saved, check the saved values before trying again. A pending save stays with the Group you edited, even if you switch to another Group.

When you upload a new avatar picture for a Group, clear it, or choose an icon, the old picture is deleted once the change saves. If the change can't save, the old picture stays, so the Group never points at a picture that is gone.

Settings → Groups → the Group → delete. This removes the Group and its avatar pictures. Its chats stay, as ordinary chats. The pictures are stored by batshit-server, so Batshit checks that batshit-server is running before it deletes anything; if it is not, nothing is deleted and the error says so. Restart Batshit (in Docker, run `./start-docker.sh`) and try again.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| An agent can't be added to a Group | The saved record is missing or uses a retired type. | Delete the retired record and create an `API` or `CLI` agent. |
| The group feels stuck | Turns are sequential, so one agent's slow or stuck tool call holds the line. | Check that agent's model/provider and tools on their own. |
| The wrong agent keeps answering | Speak policies, or you didn't name a specific agent. | Address an agent by name, adjust speak policies, or put the agents on **Judge Juice: Smart** so a judgment model picks. |
| Agents ignore each other | Tool results aren't shared, so they're missing each other's context. | Turn on tool sharing for the results the group should see. |
| No Goon appears | The current speaker has no ready Goon assigned, or the Dock/Desktop Mode is not active. | Assign a ready Goon to that agent and open the Goon Dock. |
| The idle Goon is not the one you expected | The Group driver is the idle visual fallback when it is valid. | Check the Group driver and each agent's Goon assignment. |

## Related docs

- [Primary Agents](../primary-agents/overview.md)
- [Subagents](../subagents/overview.md)
- [Voice](../voice/overview.md)
- [3D Goons](../goons/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
