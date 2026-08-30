# Streaming, recovery, and transparency

Batshit treats a live agent run as something you can watch, interrupt, recover, and inspect.

## One streaming contract

API providers, Codex CLI, and Claude CLI produce different native event shapes. Batshit normalizes them into one stream for text, reasoning, tool calls, tool results, errors, and completion. That single contract drives the same chat renderer, tool cards, Zips, and spectator-tab behavior across both Primary Agent types.

More than one browser tab can watch the same active chat. Reconnecting tabs receive the buffered event sequence with stable event IDs so already-applied text and tool results are not duplicated.

## Tool output compresses during the run

When a tool returns a large result, Batshit stores it as a [Zip](../tools/zips.md) when the result arrives and inserts a compact reference into the transcript. Later model calls do not repeatedly carry the full raw output unless the Zip is deliberately opened.

## Failed work is preserved

If a run fails after producing text or tool results, Batshit keeps that partial work and marks the assistant message with the real failure. The error survives a reload, and the next model run can see that the previous response ended early.

If a run fails before producing anything, Batshit still saves a visible error-state assistant message instead of leaving a permanent “Thinking…” placeholder.

## Context-exhaustion recovery

Managed Codex and Claude CLI runs watch live token usage and stop gracefully near the configured context threshold. Batshit finalizes the partial work, then can start a fresh continuation from the persisted transcript where large tool results are already compact Zips.

Automatic continuation is capped. If the task still cannot continue safely, Batshit stops with a visible error instead of looping indefinitely. Group Chat uses its own turn semantics and does not auto-continue.

## Interrupts

Stopping a run preserves completed text and tools, marks the message as interrupted, and releases the chat for the next send. Sending another message in the same active chat first interrupts the current turn so two responses cannot overlap in one transcript.

## Execution Viewer

The [Execution Viewer](../chat/execution-viewer.md) shows the compiled prompt, runtime, tool activity, usage, cache evidence when reported, and failure metadata for each run. Use it to inspect what Batshit actually sent and received instead of guessing from the visible chat alone.

## Related

- [Agents and runtime paths](agents-and-runtime-paths.md)
- [Execution Viewer](../chat/execution-viewer.md)
- [Compact and Trim](../chat/compact-and-trim.md)
- [Zips](../tools/zips.md)
