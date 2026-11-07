# Claude plan

You can use your own Claude plan as the model for an ordinary agent. Batshit runs your own copy of Claude Code, signed in with your Claude plan, and Claude Code acts only as the model. Batshit runs every tool itself. This connection is available in the Mac app. Docker has not been qualified for this connection yet.

Anthropic decides which models and usage limits your plan has. Batshit never sees, stores or sends your Claude password or sign-in token: Claude Code keeps its own sign-in.

## Set it up

1. Open **Settings → API Keys → Claude Plan**.
2. If Claude Code is not installed yet, press **Install Claude Code CLI** in the card (or **Install Batshit-managed copy** if you already have your own copy). Batshit installs the Claude Code version it was tested with.
3. Sign in to Claude Code with your Claude plan. The card shows the sign-in command (`claude auth login`) with a copy button. Run it once in Terminal. Sign in with your Claude plan, not with an API key.
4. Press **Check Again**. When the card says **Ready**, you can use the connection.
5. Open **Settings → Models**, choose the **Claude Plan** connection and pick a model. **CLI default** lets Claude Code choose. Set **Reasoning effort** if you want; on Opus 4.8, Opus 4.6 and Sonnet 5 you can also turn **Thinking** on or off. Save the preset.
6. Choose that preset for an agent in Agent Settings, or for a Subagent in Subagent settings. A Worker uses its agent's model, or, when it is based on a Subagent, that Subagent's model.

## What the card tells you

- **Not installed yet:** install Claude Code from the card.
- **Not signed in:** run the sign-in command, then press Check Again.
- **Signed in, but not with a Claude plan:** Claude Code is set up to use an API key, a sign-in token or a cloud provider. Remove that from Claude Code's settings, sign in with your Claude plan, then press Check Again.
- **Sign-in does not show a Claude plan, or Batshit could not read it:** sign in with your Claude plan using the command, then press Check Again.
- **Batshit cannot use this Claude Code:** it is not the exact version Batshit was tested with, or it could not run. Install or update it from the card.
- **Turned off for this Batshit install:** Claude Code is switched off in this install's settings (`BATSHIT_CLAUDE_PROVIDER_ENABLED=false`).

After you sign in from Terminal, press **Check Again**: model pickers that are already open update at once. The card's **Check Claude Usage** link opens your plan's usage page.

## What it can do

- **Chat replies** for agents, with Batshit's tools, memory, Skills and your usual tool settings.
- **Subagents and Workers**, with the same Stop, time and step limits as any Subagent. Up to six Workers run at once.
- **Compact** on the chat's own model or a Claude plan Compact preset.
- **Images:** attached images reach the model.
- **Thinking** streams into the reply like any other model's, and your agent's Display Reasoning setting can hide it.

It does not run artifacts, memory's background summaries, embeddings, voice or media features, or n8n. Choose a separate API-compatible preset for those; Batshit tells you when a feature cannot use the Claude plan.

## What counts against your plan

Every reply, Subagent run, Worker run and Compact that uses the Claude Plan connection counts against your Claude plan's usage limits, including its thinking and the tool results Batshit sends back to the model. Claude Code also adds a little of its own context to each model call.

In the chat's token panel, **Total Cost** becomes **Claude Plan**, a link to your usage page ([claude.ai/settings/usage](https://claude.ai/settings/usage)). Batshit shows token counts when Claude Code reports them. It never shows a dollar figure and never guesses a missing count as zero.

If your plan's usage limit is reached, the reply stops with: "Your Claude plan's usage limit is reached, so Claude did not answer. Batshit does not retry by itself: send the message again after the limit resets, or choose another model." Claude Code's own words may follow. Batshit never switches to a paid Anthropic API key by itself.

If extra usage is turned on for your Claude account, Claude Code can keep answering past your plan's limit, and Anthropic may bill that extra usage. Batshit does not stop it. Turn extra usage off in your Claude settings if you do not want that.

## Safety

A Claude plan agent's or Subagent's commands run under Batshit's Sandbox, Work mode, allow and Always Block lists and protected-source guard, which the removed Claude Code CLI lanes' own shell never had. Claude Code's own tools are turned off; only the tools you allow in Batshit reach the model.

## Good to know

- Stop works at any moment, also while a tool runs.
- Deleting a chat ends its Claude Code runs first; deleting an agent ends that agent's runs; restoring a backup ends every run and starts no new one until the restore is done.
- An Anthropic API key in Settings → API Keys is a separate, paid connection. A Claude plan preset never uses it.
