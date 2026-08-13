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

Group Chat is launch-supported for `API` and `CLI` Primary Agents. `n8n` Primary Agents don't join normal Groups, because the group runtime relies on the direct provider/CLI conversation path.

Each agent in a Group keeps its own model, system prompt, personality, voice, and tool access. That's the point — a Group is a room full of *different* agents, not one agent wearing hats.

## How turns work

The single-speaker queue is the heart of it:

- One agent speaks at a time. Batshit never lets two responses stream over each other.
- Each agent sees the responses that came before it in the round, so replies build on each other instead of ignoring each other.
- After the round, the conversation can continue with follow-up turns so agents can actually respond to one another, not just answer you once.

You steer who talks. By default, speaker selection is flexible — Batshit picks a reasonable next speaker — but when you name a specific agent, that agent is the one who answers. Speak policies let you tune how eager each agent is to jump in versus waiting until it's directly addressed.

## Tool sharing

Agents in a Group can share tool results so the group stays on the same page. Shared tools are visible to the other agents; unshared tool output is summarized for everyone else rather than dumped in full. Set tool sharing intentionally — it's how you decide whether the group works from a common set of results or each agent keeps its own.

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

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| An agent can't be added to a Group | It's an `n8n` Primary Agent. | Groups are launch-supported for `API` and `CLI` agents. |
| The group feels stuck | Turns are sequential, so one agent's slow or stuck tool call holds the line. | Check that agent's model/provider and tools on their own. |
| The wrong agent keeps answering | Speak policies, or you didn't name a specific agent. | Address an agent by name, or adjust speak policies. |
| Agents ignore each other | Tool results aren't shared, so they're missing each other's context. | Turn on tool sharing for the results the group should see. |
| No Goon appears | The current speaker has no ready Goon assigned, or the Dock/Desktop Mode is not active. | Assign a ready Goon to that agent and open the Goon Dock. |
| The idle Goon is not the one you expected | The Group driver is the idle visual fallback when it is valid. | Check the Group driver and each agent's Goon assignment. |

## Related docs

- [Primary Agents](../primary-agents/overview.md)
- [Subagents](../subagents/overview.md)
- [Voice](../voice/overview.md)
- [3D Goons](../goons/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
