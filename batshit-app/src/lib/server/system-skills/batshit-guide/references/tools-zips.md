# Zips

Most AI chat apps drag every long log, diff, and tool result through the whole conversation, burning context — and money — on output nobody is re-reading. Batshit's Zip system compresses large output automatically: the chat still shows it, but the model only carries a compact reference unless the content is actually needed. This is the core of how Batshit keeps long, tool-heavy conversations affordable and readable.

This page explains what Zips are and why they exist. For the hands-on UI, see [the Zip Manager](../chat/zip-manager.md); for whole-conversation context controls, see [Compact and Trim](../chat/compact-and-trim.md); for reusable attachments you upload, see [Clips](../clips/overview.md).

## Zips

A Zip is Batshit's compressed representation of large assistant or tool output. Zips exist because:

- Long code blocks and logs waste model context.
- Tool results can be huge.
- You should still be able to inspect the full output.
- Agents shouldn't have to carry every giant result into every future message.

When Batshit zips something, the chat still shows it through a card or expandable view. The model sees a compact reference unless the item is in the recent buffer, held open (by you or by the agent), or required by your Zip settings.

Large tool transcripts can stay compressed even when the recent buffer would normally expand them. The result stays inspectable in chat; the size rules for the model are below.

Tool Results Summary is a small note panel that can appear on assistant messages after tool calls. Agents write these notes so useful facts survive after a large result is zipped. It's collapsed by default but always visible to you — it's app metadata, not private reasoning or a hidden instruction channel. The **Tool Notes** setting that allows them is on by default and marked **Recommended**, because notes keep the facts the agent needs in view after the full result is compressed, so it reads files again less.

## What gets zipped

Common Zip content:

- Error blocks.
- Tool results.
- Image outputs from provider-native generation.

Cool Tool results are zip-first: Batshit stores the real result in Redis and renders the tool card from the Zip. If a Zip is missing or malformed, Batshit shows a clear missing-result state rather than pretending nothing happened.

Memory tools are the one exception. The agent reads a memory search or recall result during that reply, but the result is never saved as a Zip; recalled memories reach later messages through the agent's [memory](../chat/memory-and-infinite-sessions.md) instead, so nothing is stored twice. Those calls show no tool card in the chat; the Execution Viewer still lists them. When a memory result is too long, the agent is asked to search more narrowly, request fewer results, or recall one memory by its id. Batshit does not keep a separate copy of the cut memory result.

## Buffer, threshold, and behavior

Three settings control automatic zipping:

- **Zip buffer** counts previous agent/assistant responses — not user messages, and not individual tool calls. If one assistant response contains several tool calls, that whole response still counts as one. With buffer `1`, zippable content from the latest previous agent response stays expanded for the next response.
- **Zip threshold** is the minimum token size before `Normal` behavior may zip something. Most defaults use `0`, meaning there's no minimum-size floor once the buffer allows zipping.
- **Zip behavior** is the mode: `Off` keeps ordinary results open, `Normal` uses buffer and threshold, and `Auto` zips immediately by default.

### Size guard for tool results

Batshit checks how much of a saved tool result the model would read on a **later message**. It estimates the expanded text, not the card's stored data. This guard applies to Cool Tool results, including file reads, diffs, and commands:

| Estimated result size | What the model gets later |
|---|---|
| Under 10,000 tokens | Your usual Zip settings apply. |
| 10,000–24,999 tokens | A compact reference by default, even inside the recent buffer. `Off` keeps it open; your Hold or the agent's Hold can keep a live copy open, subject to Zip now and the old-copy rules below. |
| 25,000 tokens or more | A compact reference even with `Off` or a Hold. A new Hold is refused; an older Hold can still be released. |

The reference says `large: hold it or fetch it` or `too large to open: fetch it in parts`. If a result is too large, ask the agent to read a smaller file range or make a narrower tool request. This rule protects later prompts. During the reply itself, Batshit also shortens a tool result at 25,000 estimated tokens and tells the agent where it stopped.

If Fetch Zip is available to that agent, it can read the saved remainder in pages using `offset` and the returned `nextOffset`. If the tool is off for that run, the agent is told to request a smaller part instead; the setting is respected. Fetch Zip reads results from the same chat and follows the chat's group-sharing rules. In a group chat, only the member's own reply can read the copy it kept, so a Subagent there is told to request a smaller part instead of being given a copy it cannot read.

The API chat card keeps the ordinary tool result, including the existing display limits for command output. A Codex or Claude card shows the shortened result that its agent received. Batshit keeps a separate copy for reading the rest: up to 8,000,000 characters per copy and fifty copies per reply. The notice says when later text was dropped or a copy could not be kept. These copies follow the chat's backup and deletion rules. Codex may have a smaller result limit; Batshit fits the result and its read-more pages within that limit without changing your setting. Results produced directly by a CLI's own tools still use that vendor's output limits.

For Batshit-run Bash, Agent Browser, and saved CLI commands, the saved remainder can include output beyond the card’s display limit. When such a command's result is shortened, the first part starts with the exit code and the end of the command's error output, then its normal output, so the agent always sees why a command failed. The notice reports when a stopped command could not finish collecting output. The Docker host operator cannot keep a command’s remainder beyond its output cap; it says so and asks the agent to run a smaller request.

### Old copies of a file compress at once

When an agent reads a file, the result is a copy of that file. Two things make a copy useless: the agent reads the whole file again (now it has a newer copy), or the agent edits the file (now the copy is wrong). Batshit compresses such a **dead copy** on the agent's next reply, whatever the buffer says, and its label says why: `superseded by a later read` or `stale, edited since`. A partial read (a few lines, the top of a file) never replaces an earlier copy, and when Batshit can't be sure which files a command read, the copy stays. A file read through an MCP file tool (such as a Filesystem gateway's `read_file`) counts as a full read only when the whole file came back in the result; a longer file read that way is kept only in part, so it stays open by the normal rules and can't be held. Below the 25,000-token guard, a read you hold yourself stays open; the `Off` behavior keeps dead copies open too. An agent's own hold doesn't: after the agent edits a file it holds, the old copy compresses and its next eligible full read of the file is held instead.

The agent always knows what happens next. Every open file read ends with one short line, such as `Compresses 8 replies after it was read.`, and on its last reply `Compresses after this reply. Note what you need or hold the file.` A held read says who holds it instead, such as `Held by the user: stays open until they release it.` Compressing deletes nothing: the card in the chat still shows the whole result, and the agent can fetch the exact earlier result (an old version of a file, what a command printed then) when it needs it.

## Hold and release

Zips mostly manage themselves, but you stay in control. To keep something open for the model, **hold** it: from its Zip badge or the Zip Manager, choose **Hold** (it stays open until you release it) or **Hold for 10 messages**. **Zip now** compresses something at once, and **Release** gives anything you held or zipped back to the automatic rules.

A result at the 25,000-token size limit cannot be opened whole by a new Hold. If you already held it, the Hold stays visible and releasable while the model sees a compact reference. When an agent rereads a held file and the new whole read is too large, the hold stays with the older copy until a smaller whole read can take it; Batshit tells the agent that the move was refused.

Agents hold too, with the same words. An agent can hold a file it read (a spec, a skill it's following, the file it keeps working in) by naming the file in its Tool Notes, and release it when it's done. Its hold follows the file: when the agent reads the whole file again, the hold moves to the new copy and the old one compresses. Agents can only hold files they read in full, never other results.

Both of you see one state. The badge says who holds what ("Held by you", "Held by you (3 messages left)", or the agent's name, such as "Held by Scout"), and the agent sees your holds too, so it never holds the same file again. Your holds always win: an agent can't release, override, or undo what you hold or zip, and you can release anything an agent holds, even an old copy that is already compressed. These controls sit on top of the normal buffer and threshold behavior.

A hold lasts until someone releases it. If you switch a chat to another agent, the first agent's holds stay, and you can release them from the badge or the Zip Manager. Deleting an agent releases all of its holds, in every chat.

Earlier versions had a **Zip Control Permissions** setting that let an agent zip and unzip results itself. Hold and release replaced it, so that setting is parked: it no longer appears in Settings and stays off.

Changing a Zip while an agent is mid-answer affects later model calls and future sends. It doesn't change what the already-running call has seen, but the context meter updates to reflect the next send.

The hands-on UI — the inline Zip badges, the per-item actions, and the Zip Manager's filter and sort — lives in [the Zip Manager](../chat/zip-manager.md).

### Letting Batshit manage the exceptions (optional)

Zips are a trade: fewer tokens, but the agent is left with a one-line label where a file used to be. Usually that's the right trade. Sometimes the label is for exactly the file your next message is about, and sometimes a result stays expanded for turns after the agent finished with it.

If you use [Judge Juice](../judge-juice/overview.md), the **Judge Juice: Smart Zip** switch in the Global Tool Grid hands those exceptions to a fast judgment model. Before each reply it unzips the one or two zipped results your message clearly needs, for that message, and only names the ones it's less sure about. It cannot open a result at the large or too-large size floor. After each reply it zips the results the agent is finished with, instead of waiting for the buffer. Everything it does is marked (a lightning bolt on the Zip badge), the agent is told each time, and your own holds and zips win within the size guard. It sends your message, the reply, and those one-line labels (never the results themselves) to TypeSafe's servers, so it is off until you turn it on.

## Context controls

Zips shrink individual results. For the conversation as a whole — temporarily trimming older messages, permanently compacting them into a summary, and what happens when an agent runs out of context mid-task — see [Compact and Trim](../chat/compact-and-trim.md).

## Related docs

- [The Zip Manager](../chat/zip-manager.md)
- [Judge Juice (optional)](../judge-juice/overview.md)
- [Compact and Trim](../chat/compact-and-trim.md)
- [Clips](../clips/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](overview.md)
