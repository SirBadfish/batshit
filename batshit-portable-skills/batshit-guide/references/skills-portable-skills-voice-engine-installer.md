# Portable Voice Engine Installer

The Portable Voice Engine Installer lets an outside coding agent install, connect, health-check, register, smoke-test, and enable local or self-hosted TTS/STT engines in Batshit.

Use it when local voice setup is too long or technical to do by hand, especially for Apple Silicon MLX engines, self-hosted OpenAI-compatible speech servers, or cloned-voice-capable local engines.

## What you need

- Batshit running locally.
- A Portable Skill Token with the `Voice Engines` scope.
- The downloaded `voice-engine-installer` Portable Skill bundle.
- Enough local disk/CPU/GPU room for the engine you want.

Download links are listed in [Portable Skill downloads](../reference/portable-skills.md).

## What the skill is allowed to do

With the `Voice Engines` scope, the outside agent can call Batshit controls for voice-engine setup, health checks, model actions, enable/disable, deletion, and approved runtime add-on status/start/stop where supported.

It should not:

- edit Batshit source;
- write Redis directly;
- use `BATSHIT_TOKEN`;
- install Python packages globally;
- enable an engine before health and smoke proof.

Batshit-managed local installs should live under:

```txt
~/.batshit/installs/<engine-id>/
```

Some shared runtimes, such as MLX audio, may use a shared Batshit-managed tool root such as:

```txt
~/.batshit/tools/mlx-audio/
```

## Recommended prompt

After installing the bundle into your outside agent, use a prompt like:

```txt
Use the Batshit Portable Voice Engine Installer.

Batshit base URL: http://127.0.0.1:5620
Token env file: ~/.batshit/portable-skills/portable-skills.env

Install and register a local TTS engine that is suitable for responsive voice chat on this Mac. Ask me only if there is a real choice I need to make.
```

For Docker Batshit, add that the engine runs on the host and Batshit may need a container-reachable URL such as `host.docker.internal`.

## Completion should prove

A good completion report includes:

- engine name and `byo:<engineId>`;
- install location;
- TTS, STT, and clone capability truth;
- health check result;
- smoke test result;
- whether the engine is enabled;
- any remaining step you must do in Voice Settings.

Do not accept "installed" as done if Batshit cannot health-check or smoke-test the engine.

## Useful follow-up

After setup, open Settings -> Voice and confirm:

- the engine appears in Engine Manager;
- the engine is enabled only if smoke passed;
- voices appear in the relevant dropdowns;
- clone profiles or reference-audio fields are honest for that engine.

If an engine is slow, ask the agent whether it is quality-first or real-time-suitable. Some engines sound great but are not comfortable for live voice chat on every machine.
