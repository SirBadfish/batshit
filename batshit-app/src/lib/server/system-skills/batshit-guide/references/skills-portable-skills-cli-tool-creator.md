# Portable CLI Tool Creator

The Portable CLI Tool Creator lets an outside coding agent inspect a command or script, turn it into a structured Batshit CLI Tool record, and validate the saved record.

Use it when you have a local command you want Batshit agents to call safely and repeatably.

## What you need

- Batshit running locally.
- A Portable Skill Token with the `CLI Tools` scope.
- The downloaded `cli-tool-creator` Portable Skill bundle.
- The command, script, or program you want registered.

Download links are listed in [Portable Skill downloads](../reference/portable-skills.md).

## What the skill is allowed to do

With the `CLI Tools` scope, the outside agent can list, read, create, update, test, archive, or delete Batshit CLI Tool records.

It should not:

- register a vague raw shell string;
- hide network, write, or secret needs;
- create duplicates when updating is right;
- register a host-only command for Docker Batshit unless the selected runtime can execute it;
- skip validation unless you explicitly tell it to.

## Runtime matters

A CLI Tool must be executable from the runtime that will actually run it.

For Mac app Batshit, that is usually your host Mac.

For Docker Batshit, a command installed only on the host is not automatically available inside the app container. The agent may need to use an app-container command, a configured worker, a sidecar, or a connect-existing service. If the runtime cannot execute the tool, the right answer is a clear blocker, not a fake registration.

## Recommended prompt

```txt
Use the Batshit Portable CLI Tool Creator.

Batshit base URL: http://127.0.0.1:5620
Token env file: ~/.batshit/portable-skills/portable-skills.env

Turn [command or script] into a Batshit CLI Tool. Inspect it safely, infer the manifest, save it, run the validation test, and tell me whether it needs a companion skill.
```

## Completion should prove

A good completion report includes:

- CLI Tool name and `toolId`;
- executable and runtime location;
- structured inputs;
- output and parse mode;
- risk, network, write, and secret notes;
- validation test result;
- whether a companion Skill would help.

After setup, open Settings -> Tools -> CLI Tools to inspect or adjust the saved record.
