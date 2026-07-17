# Compact and Trim

Long, tool-heavy conversations eventually strain the model's context window. Batshit gives you two manual controls in the Token Panel — Manual Trim and Compact — plus automatic recovery when an agent runs out of room mid-task. This page covers all three. The Zip system that keeps individual results small is covered in [Zips](../tools/zips.md).

## Manual Trim and Compact

The Token Panel under the chat has two tools for long conversations:

- **Manual Trim** temporarily excludes older eligible messages from future sends. It's reversible with Reset Trim, and the visible transcript stays intact.
- **Compact** permanently replaces eligible older context with one expandable summary row. Future agents receive the summary instead of the original messages.

Manually unzipped content and active Clips stay live through both — including content you opened and content an agent opened through zip-control permission. The Compact confirmation uses Batshit's server-side prompt budget, including model context limits and Codex CLI packaged input limits where relevant. If the next prompt can't be sent safely, Batshit says so before launching the agent.

## When an agent runs out of context mid-task

Long, tool-heavy runs (API and CLI agents) can fill the model's context window before the task is done. Batshit doesn't throw the work away:

- Everything the agent already produced — text and tool results — stays in the chat, with a clear note that the run hit the context limit.
- Batshit automatically starts a fresh continuation. The new run reads the saved history, where tool results are compact Zips that cost almost nothing, and picks up where it stopped.
- Auto-continue is capped at 3 continuations per request, so a task that can never fit stops with a visible error instead of looping.

For managed CLI agents (Codex and Claude Code), Batshit also watches token usage live and stops gracefully at around 80% of the context window — the note reads "Batshit context guard" — so most long tasks relay to a continuation before hitting the wall.

Group chats don't auto-continue: the failed turn stays preserved, and you can ask the group to continue normally.

The same care applies to any run that dies mid-task for other reasons, like a provider rate limit, a crash, or you stopping it:

- The message shows a clear failure banner with the actual error text, and it survives a reload.
- Tool results from the unfinished run are held un-zipped — even auto-zip types like Bash — so when you tell the agent to continue, it can still see what it was doing. Normal Zip rules resume once the agent completes a turn, and your manual controls still win if you want something compressed sooner.

## Related docs

- [Zips](../tools/zips.md)
- [The Zip Manager](zip-manager.md)
- [The chat workspace](overview.md)
- [Execution Viewer](execution-viewer.md)
