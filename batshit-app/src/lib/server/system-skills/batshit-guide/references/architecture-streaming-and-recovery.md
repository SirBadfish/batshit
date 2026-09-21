# Streaming, recovery, and transparency

Batshit treats a live agent run as something you can watch, interrupt, recover, and inspect.

## One streaming contract

API providers, Codex CLI, and Claude CLI produce different native event shapes. Batshit normalizes them into one stream for text, reasoning, tool calls, tool results, errors, and completion. That single contract drives the same chat renderer, tool cards, Zips, and spectator-tab behavior across both Primary Agent types.

More than one browser tab can watch the same active chat. Reconnecting tabs receive the buffered event sequence with stable event IDs so already-applied text and tool results are not duplicated.

All the Batshit tabs in one browser share a single live connection to Batshit, so you can keep several tabs or windows open, each on its own chat, without them slowing each other down. (A browser allows only six connections to one server, and each tab used to keep two of them busy.) If the connection drops or Batshit restarts, open tabs reconnect on their own, without a reload.

A running reply doesn't keep a connection busy either, so you can have several replies running at once, in one tab or across tabs, and everything else, Stop included, still answers right away. (Each running reply used to hold one of those six, so five replies at once froze the rest of Batshit until one finished.) A reply keeps running until you press Stop or quit Batshit: closing or reloading its tab doesn't stop it, and any tab showing that chat still sees it finish.

## Tool output compresses during the run

When a tool returns a large result, Batshit stores it as a [Zip](../tools/zips.md) when the result arrives and inserts a compact reference into the transcript. Later model calls do not repeatedly carry the full raw output unless the Zip is deliberately opened.

## Failed work is preserved

If a run fails after producing text or tool results, Batshit keeps that partial work and marks the assistant message with the real failure. The error survives a reload, and the next model run can see that the previous response ended early.

If a run fails before producing anything, Batshit still saves a visible error-state assistant message instead of leaving a permanent “Thinking…” placeholder.

## Context-exhaustion recovery

Managed Codex and Claude CLI runs watch live token usage and stop gracefully near the configured context threshold. Batshit finalizes the partial work, then can start a fresh continuation from the persisted transcript where large tool results are already compact Zips.

Automatic continuation is capped. If the task still cannot continue safely, Batshit stops with a visible error instead of looping indefinitely. Group Chat uses its own turn semantics and does not auto-continue.

## Interrupts

Stopping a run preserves completed text and tools, marks the message as interrupted, and releases the chat for the next send. Stop works at any moment of a reply: while the agent is still getting ready (before any words appear), while it writes, and while it runs a command. A running command is stopped too, on every agent type, so the reply usually ends in under a second. So is everything that command started, such as a program it started in the background, on your Mac and inside a sandbox (Apple Container or Docker Sandbox). A command that reaches its time limit is ended the same way. A program that a command left running on purpose and then finished (for example a server started with `nohup … > log 2>&1 &`) keeps running until you quit Batshit. Inside a sandbox it runs only until the reply ends, because Batshit removes a chat's sandbox when each reply ends. Batshit's own Bash tool tells agents both rules. **Stop is the only thing that interrupts a reply.** Sending while an agent is still replying steers or queues your message instead (see [Steer or Queue while the agent is busy](../chat/overview.md#steer-or-queue-while-the-agent-is-busy)), so two responses can never overlap in one transcript.

The first message you send after a Stop tells the agent that its previous reply was cut short, so it picks up from a stop rather than carrying on as if it had finished. Only that one message carries the note, and only in the chat you stopped.

## Execution Viewer

The [Execution Viewer](../chat/execution-viewer.md) shows the compiled prompt, runtime, tool activity, usage, cache evidence when reported, and failure metadata for each run. Use it to inspect what Batshit actually sent and received instead of guessing from the visible chat alone.

## Related

- [Agents and runtime paths](agents-and-runtime-paths.md)
- [Execution Viewer](../chat/execution-viewer.md)
- [Compact and Trim](../chat/compact-and-trim.md)
- [Zips](../tools/zips.md)
