# Portable Artifact Creator

The Portable Artifact Creator lets an outside coding agent build, validate, update, publish, and place Batshit Artifacts through a Portable Skill Token.

Use it when you want a full coding agent to author the artifact HTML and wiring outside Batshit, then save the result back into your local Batshit instance.

## What you need

- Batshit running locally.
- A Portable Skill Token with the `Artifacts` scope.
- The downloaded `artifact-creator` Portable Skill bundle.
- A clear request for the artifact you want.

Download links are listed in [Portable Skill downloads](../reference/portable-skills.md).

## What the skill is allowed to do

With the `Artifacts` scope, the outside agent can call artifact controls for listing, reading, creating, updating, patching, validating structure, publishing, zone placement, webhooks, versions, run logs, and model catalog search.

It should not:

- edit Batshit source;
- bypass structure validation;
- silently choose a fallback model;
- paste API keys into artifact HTML;
- publish a runtime that cannot be reached from the right caller.

## The important artifact rule

Batshit enforces artifact structure by default. Normal artifacts should use Builder Kit and a Fabric runtime contract:

- Builder Kit controls through `window.batshit.builder.*`
- `metadata.fabric_fields` for typed agent use, or
- `metadata.run_only=true` for trigger-only artifacts

The portable skill should run `sys.artifact.validate_structure` before create, update, patch, or publish.

## Recommended prompt

```txt
Use the Batshit Portable Artifact Creator.

Batshit base URL: http://127.0.0.1:5620
Token env file: ~/.batshit/portable-skills/portable-skills.env

Build a Batshit artifact that [describe what you want]. Validate it before saving, publish it when it is ready, and tell me where it landed.
```

If the artifact talks to n8n, ComfyUI, Gradio, HuggingFace, a webhook, or another local runtime, say whether Batshit is Mac app or Docker so the agent chooses the right URLs.

## Completion should prove

A good completion report includes:

- artifact name and ID;
- new vs updated;
- Artifact Power Source;
- validation result;
- published status and zone;
- model or runtime URL truth when relevant;
- run-log evidence when relevant.

For image or AI artifacts, a saved and published shell is not enough. The agent should run it once when practical and inspect run logs.
