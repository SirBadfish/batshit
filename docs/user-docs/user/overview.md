# User

The User area is your personal account and preferences for this Batshit instance — your profile, your global custom prompt, and your session settings. It lives at Settings → User. This page is deliberately short, because the User area is intentionally small.

Because Batshit is single-user-per-instance for alpha, "user" here means *you*, the person running this instance. There's no roster of accounts to manage. The User area is just the handful of settings that are about you personally rather than about the whole instance (which is the [Admin](../admin/overview.md) area) or about a specific agent.

## What's here

The User area holds three things:

- **Profile** — your display name and avatar. This is also where you change your password. Profile edits save inline as you make them.
- **Global System Prompt** — your own standing instructions that apply across agents when enabled. This is the place to put a preference you want to carry everywhere (a tone, a formatting rule, a recurring constraint), rather than repeating it on every agent. It's saved through its own editor, and you can turn its inclusion on or off per agent when you set agents up.
- **Session** — session-related preferences for your account.

That's the whole area. If a setting feels like it should be in User but isn't here, it's probably either a per-agent setting (in [Agent Settings](../primary-agents/overview.md)) or an instance-wide control (in [Admin](../admin/overview.md)).

## Why it's small

Batshit's behavior is shaped mostly at two other levels: per agent (each agent's own model, prompt, tools, and access) and per instance (the Admin controls). The User area stays small on purpose, holding only what's genuinely personal and account-level. As Batshit grows, more user-level preferences may land here — for now, this is honestly what's in it.

## Related

- [Admin](../admin/overview.md) — instance-wide settings, separate from your personal account.
- [Skills & Prompts](../skills/overview.md) — saved prompt templates and Skills, which work alongside your global custom prompt.
- [Primary Agents](../primary-agents/overview.md) — per-agent settings, where most behavior is actually configured.
