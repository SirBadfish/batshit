# Zips

Most AI chat apps drag every long log, diff, and tool result through the whole conversation, burning context — and money — on output nobody is re-reading. Batshit's Zip system compresses large output automatically: the chat still shows it, but the model only carries a compact reference unless the content is actually needed. This is the core of how Batshit keeps long, tool-heavy conversations affordable and readable.

This page explains what Zips are and why they exist. For the hands-on UI, see [the Zip Manager](../chat/zip-manager.md); for whole-conversation context controls, see [Compact and Trim](../chat/compact-and-trim.md); for reusable attachments you upload, see [Clips](../clips/overview.md).

## Zips

A Zip is Batshit's compressed representation of large assistant or tool output. Zips exist because:

- Long code blocks and logs waste model context.
- Tool results can be huge.
- You should still be able to inspect the full output.
- Agents shouldn't have to carry every giant result into every future message.

When Batshit zips something, the chat still shows it through a card or expandable view. The model sees a compact reference unless the item is in the recent buffer, manually unzipped, or required by your Zip settings.

Very large tool transcripts can stay compressed even when the recent buffer would normally expand them — this protects the next model request from giant file reads, diffs, and logs. The result stays inspectable in chat, and an agent can fetch the Zip when it genuinely needs the raw content.

Tool Results Summary is a small note panel that can appear on assistant messages after tool calls. Agents write these notes so useful facts survive after a large result is zipped. It's collapsed by default but always visible to you — it's app metadata, not private reasoning or a hidden instruction channel.

## What gets zipped

Common Zip content:

- Error blocks.
- Tool results.
- Image outputs from provider-native generation.

Cool Tool results are zip-first: Batshit stores the real result in Redis and renders the tool card from the Zip. If a Zip is missing or malformed, Batshit shows a clear missing-result state rather than pretending nothing happened.

## Buffer, threshold, and behavior

Three settings control automatic zipping:

- **Zip buffer** counts previous agent/assistant responses — not user messages, and not individual tool calls. If one assistant response contains several tool calls, that whole response still counts as one. With buffer `1`, zippable content from the latest previous agent response stays expanded for the next response.
- **Zip threshold** is the minimum token size before `Normal` behavior may zip something. Most defaults use `0`, meaning there's no minimum-size floor once the buffer allows zipping.
- **Zip behavior** is the mode: `Off` never zips, `Normal` uses buffer and threshold, and `Auto` zips immediately by default.

## Controlling Zips

Zips mostly manage themselves, but you stay in control. From the chat you can manually unzip something so the model sees it again, zip something now to shrink context, or return a manually changed Zip to automatic behavior. Content you unzip is treated as user-owned: an agent shouldn't silently rezip something you deliberately opened. These manual controls sit on top of normal buffer and threshold behavior. You can also let an agent request zip changes, if you've enabled that permission.

Changing a Zip while an agent is mid-answer affects later model calls and future sends. It doesn't change what the already-running call has seen, but the context meter updates to reflect the next send.

The hands-on UI — the inline Zip badges, the per-item actions, and the Zip Manager's filter and sort — lives in [the Zip Manager](../chat/zip-manager.md).

## Context controls

Zips shrink individual results. For the conversation as a whole — temporarily trimming older messages, permanently compacting them into a summary, and what happens when an agent runs out of context mid-task — see [Compact and Trim](../chat/compact-and-trim.md).

## Related docs

- [The Zip Manager](../chat/zip-manager.md)
- [Compact and Trim](../chat/compact-and-trim.md)
- [Clips](../clips/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](overview.md)
