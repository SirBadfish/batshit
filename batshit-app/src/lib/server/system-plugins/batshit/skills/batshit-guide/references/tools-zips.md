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

An authorized [App Actions](../fabric/app-actions.md#connect-an-mcp-source-during-a-task) workflow can change explicitly named MCP tool Zip rules. It discovers names first, preserves unrelated rows and requires Context Management for explicit Zip intent. Connecting a source alone grants no tool-use permission.

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

A chat tool card keeps the ordinary tool result, including the display limits for command output. Batshit keeps a separate copy for reading the rest: up to 8,000,000 characters per copy and fifty copies per reply. The notice says when later text was dropped or a copy could not be kept. These copies follow the chat's backup and deletion rules.

For Batshit-run Bash, Agent Browser, and saved CLI commands, the saved remainder can include output beyond the card’s display limit. When such a command's result is shortened, the first part starts with the exit code and the end of the command's error output, then its normal output, so the agent always sees why a command failed. The notice reports when a stopped command could not finish collecting output. The Docker host operator cannot keep a command’s remainder beyond its output cap; it says so and asks the agent to run a smaller request.

### Old copies of a file compress at once

When an agent reads a file, the result is a copy of that file. Two things make a copy useless: the agent reads the whole file again (now it has a newer copy), or the agent edits the file (now the copy is wrong). Batshit compresses such a **dead copy** on the agent's next reply, whatever the buffer says, and hovering its Zip badge says why: `superseded by a later read` or `stale, edited since`. A partial read (a few lines, the top of a file) never replaces an earlier copy, and when Batshit can't be sure which files a command read, the copy stays. A file read through an MCP file tool (such as a Filesystem gateway's `read_file`) counts as a full read only when the whole file came back in the result; a longer file read that way is kept only in part, so it stays open by the normal rules and can't be held. Below the 25,000-token guard, a read you hold yourself stays open; the `Off` behavior keeps dead copies open too. An agent's own hold doesn't: after the agent edits a file it holds, the old copy compresses and its next eligible full read of the file is held instead.

The agent always knows what happens next. Every open file read ends with one short line, such as `Compresses 2 replies after it was read.`, and on its last reply `Compresses after this reply.` with a reminder to save what it needs or hold the file. With Tool Notes off for that agent, the reminder only says to hold the file, and notes the agent sends anyway are not saved: the agent is told so. A held read says who holds it instead, such as `Held by the user: stays open until they release it.` Compressing deletes nothing: the card in the chat still shows the whole result, and the agent can fetch the exact earlier result (an old version of a file, what a command printed then) when it needs it.

### Refreshed File Reads

A file read is a copy of the file as it was at that moment. If you or the agent changes the file later, that copy can be out of date. **Refreshed File Reads** makes sure the agent never sees an old copy as current. At the start of each new reply, each stored file-read copy Batshit automatically supplies is refreshed from the file for that reply, and it starts with a line that says so, `REFRESHED:` and the file, the range and "(at the start of this turn)". It stays fixed for the whole reply, so the agent works from one steady picture; if the agent edits the file during the reply, the edit's own result says what changed, and the next reply gets a fresh snapshot.

If Batshit cannot refresh a file read, the agent does not see the old copy at all for that reply. It stays zipped for that reply, even if you or the agent are holding it open, and the agent is told which file it was and why, so it can read the file again if it needs it. The Hold stays. Batshit can retry on later replies only while the original Zip Buffer, Hold, manual-close, size and access rules still make the copy eligible; refreshing never restarts those clocks.

- **The card keeps the original read.** The card in the chat, the history around it and the agent's "fetch the earlier result" still show what the file said when it was read. Only what the agent is given for the new reply is refreshed.
- **The usual size rules still apply.** Refreshing never resets the original Zip Buffer or Hold, overrides a manual close, or bypasses size/access rules. A copy that shrinks below a size threshold can open again only while its original eligibility still permits it. If the file has grown past the size guard, the snapshot is compressed by its new size; the agent is told how big it is now and to read just the lines it needs.
- **Group chats.** When you share a file read with the other agents in a group, you also share its refreshed contents. An agent can use another agent's read only while that agent could still read the file and the group still shares it. Batshit checks again immediately before handing the prepared request to the model provider. If that check finds sharing or the original reader's access changed, it refuses that request and asks you to send the message again. A change after provider handoff cannot recall context already handed off.
- **What the Zip badge says.** Hover the badge on a refreshed copy and, after its state, it says: "File snapshot used for the newest reply: the file as it was when that reply started (N tokens)". If the reply was prepared but Batshit did not see it sent, it says "File snapshot prepared for the newest reply (N tokens); sending it was not confirmed". If the copy was compressed because the file grew too large, it says "Measured from the file as it was when the newest reply started (N tokens); compressed, so its text was not sent". If the newest reply could not refresh the copy, the copy shows as compressed even if it is held, and the badge says "Not shown to the agent in the newest reply: not refreshed (the reason). Batshit tries again at the next reply." Retry wording is subject to that original eligibility; it does not promise that an expired or manually closed copy is read again. The badge only reports what Batshit did for the newest reply, and only while the setting is still on and available; it never reads the file itself. If Batshit restarted or the note is about a day old, the badge says whether the newest reply used a snapshot is unknown.

**Choosing the setting.** It is on by default. Change it for every agent in **Settings → Tools → Global Tool Grid → Refreshed File Reads** (**Default (On)**, **Enabled** or **Disabled**), or for one agent in **Settings → Agents → Tools → Refreshed File Reads** (**Use Global Default**, **Enabled** or **Disabled**). Both sit with the other Zip settings, **AI Zip Layout** and **Tool Notes**. An agent's own choice wins over the global one, and the new value takes effect on the agent's next reply; a reply already running keeps the snapshot it started with. Where Refreshed File Reads cannot work for an agent (its **AI Zip Layout** is **Inline**, or its computer or **Sandbox Level** is not supported), that agent's switch is greyed out with one line saying why. Your saved choice is kept, and it works again when the reason goes away. If Batshit cannot check your computer, it says so in a note and leaves the switch usable. The Global Tool Grid switch is greyed out only when your computer cannot run it; if the global **AI Zip Layout** is **Inline**, it shows a note ("The global Zip view is inline; agents that use it refresh nothing.") and the switch still works, because agents set to **Appended** use it.

**Where it works.** Refreshed File Reads works when all of these are true:

- it is a Primary Agent,
- its **AI Zip Layout** is **Appended** (with **Inline**, nothing is refreshed),
- Batshit runs on your Mac or Linux computer, not inside Docker yet, and
- the agent's **Sandbox Level** is **Local machine**, or on a Mac **Apple Container** or **Docker Sandbox** (Batshit re-reads the file on your computer, in the project folder those sandboxes share).

**Which reads refresh.** The agent read the file itself (or, in a group, another agent read it and you share it), in this chat, in the same project folder, with a simple one-file read (a plain `cat`, `sed -n`, `head` or `tail`, or the Read File tool), and the read was made **after** the setting was turned on. The file must still be a normal text file inside the project that Batshit can re-read quickly and safely. A read that is piped into a search (like `cat notes.md | grep todo`) counts as a search, not a file read. A read Batshit cannot refresh, such as a wildcard read (`cat src/*.js`), is zipped at each reply while Refreshed File Reads is on; the agent can read the file again, or keep what it found in its Tool Notes. If there are very many open reads, the newest ones are refreshed first and the rest are zipped. If you press Stop while Batshit is re-reading, the reply ends before the model is called.

**A reply that waits for your approval.** When a paused reply continues, it reuses the available frozen copies from the original reply without reading files again. It does not promise every copy is available: a copy omitted from replay, replay-capacity fitting or retained reply lineage is zipped with its reason, as are covered copies when replay is missing, expired or unusable after a restart. The remaining available copies keep their original bytes and labels; the approved action still runs under current authority. No missing copy is silently replaced with stale historical text.

## Hold and release

Zips mostly manage themselves, but you stay in control. To keep something open for the model, **hold** it: from its Zip badge or the Zip Manager, choose **Hold** (it stays open until you release it) or **Hold for 10 messages**. **Zip now** compresses something at once, and **Release** gives anything you held or zipped back to the automatic rules.

A result at the 25,000-token size limit cannot be opened whole by a new Hold. If you already held it, the Hold stays visible and releasable while the model sees a compact reference. When an agent rereads a held file and the new whole read is too large, the hold stays with the older copy until a smaller whole read can take it; Batshit tells the agent that the move was refused.

Agents hold too, with the same words. An agent can hold a file it read (a spec, a skill it's following, the file it keeps working in) by naming the file in its Tool Notes block, and release it when it's done; this works with Tool Notes off too. Its hold follows the file: when the agent reads the whole file again, the hold moves to the new copy and the old one compresses. Agents can only hold files they read in full, never other results.

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
