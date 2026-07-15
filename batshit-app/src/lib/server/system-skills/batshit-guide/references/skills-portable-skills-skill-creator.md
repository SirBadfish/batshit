# Portable Skill Creator

The Portable Skill Creator lets an outside coding agent design and save Batshit Skills or reusable Prompt commands through a Portable Skill Token.

Use it when you want a coding agent to help write the skill or prompt outside Batshit, then save it into your local Batshit instance.

## What you need

- Batshit running locally.
- A Portable Skill Token with the `Skills` scope.
- The downloaded `skill-creator` Portable Skill bundle.
- An idea for the Skill or Prompt you want.

Download links are listed in [Portable Skill downloads](../reference/portable-skills.md).

## Skill or Prompt

Use this distinction:

- Prompt: reusable text written from your point of view and inserted into messages.
- Skill: reusable instructions the agent reads so it can learn a workflow.

If you are not sure which one you want, ask the outside agent to help you decide before it writes anything.

## What the skill is allowed to do

With the `Skills` scope, the outside agent can save or import user-authored Batshit Skills and Prompt commands.

It should not:

- overwrite protected Batshit system skills;
- silently overwrite an existing custom skill or prompt;
- store real secrets inside skill files;
- import private SSH URLs or untrusted bundles;
- save before showing you what it is about to create.

The `Skills` scope currently has no harmless list/get control. The portable skill proves token scope by calling `/api/controls/find` for `sys.skill.save`, then saves only after you approve the content.

## Recommended prompt

```txt
Use the Batshit Portable Skill Creator.

Batshit base URL: http://127.0.0.1:5620
Token env file: ~/.batshit/portable-skills/portable-skills.env

Help me create a Batshit Skill that [describe the workflow]. Show me the draft before saving it.
```

For a reusable prompt:

```txt
Use the Batshit Portable Skill Creator.

Create a reusable Prompt command for [describe the repeated text pattern]. Show me the template and variables before saving it.
```

## Completion should prove

A good completion report includes:

- command name;
- type: Skill or Prompt;
- invocation pattern;
- dependencies or required tools;
- enablement notes;
- save or import result;
- any action still needed in Settings -> Skills & Prompts.

If Batshit rejects the save because the target is a protected system skill, that is expected. System skills are product-owned and cannot be changed through this user-facing portable path.
