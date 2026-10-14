# Streaming, recovery, and transparency

Batshit treats a live agent run as something you can watch, interrupt, recover, and inspect.

## One streaming contract

API providers, Codex CLI, and Claude CLI produce different native event shapes. Batshit normalizes them into one stream for text, reasoning, tool calls, tool results, errors, and completion. That single contract drives the same chat renderer, tool cards, Zips, and spectator-tab behavior across both Primary Agent types.

More than one browser tab can watch the same active chat. Reconnecting tabs receive the buffered event sequence with stable event IDs so already-applied text and tool results are not duplicated.

All the Batshit tabs in one browser share a single live connection to Batshit, so you can keep several tabs or windows open, each on its own chat, without them slowing each other down. (A browser allows only six connections to one server, and each tab used to keep two of them busy.) If the connection drops or Batshit restarts, open tabs reconnect on their own, without a reload.

Batshit itself saves every reply, whether or not a tab is watching and even when a tab's connection drops while the reply is being written, so the saved reply is always the whole reply: on screen, after a reload, and in what the agent reads next. A tab never saves a reply, so an old tab can't bring back a reply you deleted. In the rare case that Batshit's own live record of a reply has a gap, it saves the reply from its own full copy instead and shows *Batshit saved this reply from its own copy, because the live copy was incomplete.* under it. If Batshit itself quits in the middle of a reply, that reply is not saved.

If Codex loses its connection to the model in the middle of an answer, it starts the answer again by itself. Batshit then removes the unfinished first try, so the reply holds only the new answer, on screen, after a reload, and in what the agent reads next, and shows *Codex lost its connection during this answer and started it again. The unfinished first try was removed.* under it. In Voice Mode, words already spoken can't be taken back, so you may hear the start of the answer twice.

A running reply doesn't keep a connection busy either, so you can have several replies running at once, in one tab or across tabs, and everything else, Stop included, still answers right away. (Each running reply used to hold one of those six, so five replies at once froze the rest of Batshit until one finished.) A reply keeps running until you press Stop or quit Batshit: closing or reloading its tab doesn't stop it, and any tab showing that chat still sees it finish.

## Tool output compresses during the run

When a tool returns a large result, Batshit stores it as a [Zip](../tools/zips.md) when the result arrives and inserts a compact reference into the transcript. Later model calls do not repeatedly carry the full raw output unless the Zip is deliberately opened.

## Failed work is preserved

If a run fails after producing text or tool results, Batshit keeps that partial work and marks the assistant message with the real failure. The error survives a reload, and the next model run can see that the previous response ended early.

If a run fails before producing anything, Batshit still saves a visible error-state assistant message instead of leaving a permanent “Thinking…” placeholder.

## When a reply hits the model's output limit

Every model has an output limit: the most tokens it may write in one answer. A thinking model's thinking counts toward it, so a model that thinks for a long time can reach the limit before it has written much. When an API agent's reply stops there, Batshit keeps whatever the agent already wrote and did, and marks the reply "This response stopped at the model's output limit", with a line that says how to go on: ask the agent to continue, or raise **Max Tokens** in the model preset. If the model reached the limit while it was still thinking, you see the same notice instead of an empty reply. From then on, the chat history tells the agent that this reply stopped early. CLI agents run their own loop and meet this limit on their own.

Batshit sends a Max Tokens value only when the preset sets one. Without it, the provider's default limit applies, and for some models that default is lower than what the model can really do.

## Context-exhaustion recovery

Managed Codex and Claude CLI runs watch live token usage and stop gracefully near the configured context threshold. Batshit finalizes the partial work, then can start a fresh continuation from the persisted transcript where large tool results are already compact Zips.

Automatic continuation is capped. If the task still cannot continue safely, Batshit stops with a visible error instead of looping indefinitely. Group Chat uses its own turn semantics and does not auto-continue.

## Interrupts

Stopping a run preserves completed text and tools, marks the message as interrupted, and releases the chat for the next send. Stop works while an agent is getting ready, writing, or running a command. It ends a running local command and programs still in that command's managed process group; a time limit ends the command the same way. A program that deliberately moves into a different group or session can survive Stop, and Batshit cannot promise to find every such program. A program left running after its command finishes (for example a server started with `nohup … > log 2>&1 &`) can keep running until Batshit quits if it remains in the managed group. Inside Apple Container or Docker Sandbox, the chat's sandbox is removed when the reply ends. Stop also ends work the reply is waiting on, including a Subagent or Worker call, an MCP tool call, and a saved CLI tool. **Stop is the only thing that interrupts a reply.** Sending while an agent is still replying steers or queues your message instead (see [Steer or Queue while the agent is busy](../chat/overview.md#steer-or-queue-while-the-agent-is-busy)), so two responses cannot overlap in one transcript.

If Batshit cannot confirm that a Codex command stopped, the reply shows a cleanup warning that remains after you reload the chat. Stop can respond while that cleanup runs. An app restart does not prove that an old command stopped. Batshit keeps host-side records outside your chat and backup; deleting the affected agent, Subagent, or shared CLI profile can be refused after restart while a recorded program is still running or cannot be checked. The error identifies a recorded live program so you can end it yourself and retry, or restart the computer and retry. If Batshit verifies only that the recorded programs ended, it shows a recovery notice explaining that other commands the old run started may still be running. Batshit never sends a signal using only a saved process number.

The first message you send after a Stop tells the agent that its previous reply was cut short, so it picks up from a stop rather than carrying on as if it had finished. Only that one message carries the note, and only in the chat you stopped.

## Execution Viewer

The [Execution Viewer](../chat/execution-viewer.md) shows the compiled prompt, runtime, tool activity, usage, cache evidence when reported, and failure metadata for each run. Use it to inspect what Batshit actually sent and received instead of guessing from the visible chat alone.

## Related

- [Agents and runtime paths](agents-and-runtime-paths.md)
- [Execution Viewer](../chat/execution-viewer.md)
- [Compact and Trim](../chat/compact-and-trim.md)
- [Zips](../tools/zips.md)
