export function buildToolGuidanceZipPromptBlock(options?: {
  runtimeFlavor?: 'codex' | 'claude' | 'vercel'
  zipControlPermission?: 'agent' | 'user'
  zipAiViewMode?: 'inline' | 'appended'
  toolNotesEnabled?: boolean
}): string {
  const runtimeFlavor = options?.runtimeFlavor ?? 'vercel'
  const zipPermission = options?.zipControlPermission ?? 'user'
  const zipViewMode = options?.zipAiViewMode ?? 'appended'
  const toolNotesEnabled = options?.toolNotesEnabled ?? true

  const viewLine =
    zipViewMode === 'appended'
      ? 'Zip AI view: appended (unzipped content appears in a zip index at the end of chat history).'
      : 'Zip AI view: inline (unzipped content appears in place of zip references).'
  const toolUseTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_use' : 'batshit_tool_use'
  const fetchZipInstruction =
    runtimeFlavor === 'codex' || runtimeFlavor === 'claude'
      ? `Use \`batshit_server_fetch_zip\` when directly available, or ${toolUseTool} with ref="fabric:sys.zip.fetch" when the broker exposes it.`
      : `Use ${toolUseTool} with ref="fabric:sys.zip.fetch".`

  // SA-096 P1: broker guidance lives only in the Dynamic Tool Search / Discovery block
  // (buildDynamicMcpPromptBlock). This block used to restate it, so agents that received
  // both — which is the normal case — paid for it twice.
  //
  // The bash policy moves the other way: it was removed from the API base prompt, so this
  // block is now its only home. The packaged prompt already carried it; this fallback did
  // not, which would have left it stated nowhere when Redis has no stored prompt.
  const nativeBashGuidance = [
    'Native Bash Access Mode (from DCM):',
    '- If DCM includes `native_bash: ...`, treat it as the source of truth for what shell behavior is currently allowed. The user can change mode/settings at any time.',
    '- `mode=plan`: read/search + `.md` edits only; command chaining is blocked.',
    '- `mode=agent`: non-allowlisted commands require approval popups.',
    '- `mode=dangerous`: approval popups are skipped; never-allow rules still apply.',
    '- For file edits, prefer `apply_patch` so diffs render cleanly.',
    '- If a tool result says `success:false`, `blocked:true`, or `POLICY_BLOCKED`, the requested action did not happen. Say that it was not applied/executed, include the blocker reason, and do not describe it as completed.',
    '- If an edit is blocked, provide the patch or handoff for the external coding workspace when useful.'
  ]

  // SA-104 P1: Tool Notes have their own control tag, decoupled from zip
  // control, so agents without zip permission never see zip-control syntax just
  // to save notes. End-of-message stays the documented convention for bulky
  // control blocks; the strip layer makes any position safe.
  const toolNotesGuidance = toolNotesEnabled
    ? [
        '',
        'Tool Notes (your lightweight memory):',
        '- Save short factual notes about tool results you will need after the raw output is zipped.',
        '- Tool Notes are Batshit app metadata, not private reasoning and not a place for private instructions. They are user-visible through an expandable Tool Results Summary panel on your message.',
        '- Append the block at the end of your message. Never output the JSON by itself; wrap it in the tag.',
        '- Omit the block entirely when you have no useful notes.',
        'Tool Notes block example:',
        '<batshit-tool-notes>',
        '{"notes":[{"toolName":"...","summary":"exact fact(s) to retain"}]}',
        '</batshit-tool-notes>'
      ]
    : []

  if (zipPermission === 'agent') {
    return [
      `Runtime: ${runtimeFlavor} | ${viewLine}`,
      '',
      ...nativeBashGuidance,
      '',
      'How Batshit handles tool results:',
      '- Tool outputs are often zipped quickly to save tokens.',
      '- Never write visible Batshit zip reference syntax, clip reference syntax, or `**(Clip Log: ...)**` lines in your reply — those are Batshit record marks. Refer to "a zip reference", "a clip", or the visible badge in prose instead.',
      toolNotesEnabled
        ? '- Tool Notes are lightweight memory. Save only the exact facts you will need after the raw result disappears.'
        : '- Tool Notes are disabled for this agent/session.',
      '- Zip/unzip controls leave visible state through zip badges and expanded/collapsed content. Use these features for token management and continuity, not to hide information from the user.',
      '',
      'Zip control (permission ON):',
      '- Treat natural-language requests as zip-control requests. If the user or their custom instructions say things like "keep this unzipped," "unzip these memory files," "leave this tool output available," or "pin this context," use the `unzip` control when zip control is enabled; the user does not need to mention Batshit zip control or the control-block syntax.',
      '- `unzip`: for tool results from this response, use `tool_result_N` where N is the 1-based result number (`tool_result_1`, `tool_result_2`, `tool_result_3`, ...).',
      '- Never use `tool_result_0`; numbering starts at 1.',
      '- For older zips already visible in chat history, use the actual zip ID from the zip index/reference.',
      '- `zip`: use zip IDs for content you are done with and want compressed again. Do not zip user-locked items.',
      toolNotesEnabled
        ? `- Need to read a zip right now? ${fetchZipInstruction} It peeks without changing zip state. If it should stay available after this response, also put its zip ID in \`unzip\` and save important facts in Tool Notes.`
        : `- Need to read a zip right now? ${fetchZipInstruction} It peeks without changing zip state. If it should stay available after this response, also put its zip ID in \`unzip\`.`,
      '- Changes apply on the next user message.',
      '- Do not put Tool Notes inside the zip-control block; notes have their own `<batshit-tool-notes>` block.',
      '',
      'Only append a zip-control block when you actually need to change zip state.',
      'Do not append an empty zip-control block. If there are no zip changes, omit the block entirely.',
      'Put all normal spoken prose before any control blocks; append control blocks at the very end of your message.',
      'Never output the JSON by itself; it must be wrapped in `<batshit-zip-control>` and `</batshit-zip-control>`.',
      'Batshit strips the raw XML/JSON syntax from normal chat rendering, but its effects are visible in the UI.',
      'Zip-control block example (append after your normal response):',
      '<batshit-zip-control>',
      '{"unzip":["tool_result_1","tool_result_3"],"zip":["zipId"]}',
      '</batshit-zip-control>',
      ...toolNotesGuidance
    ].join('\n')
  }

  return [
    `Runtime: ${runtimeFlavor} | ${viewLine}`,
    '',
    ...nativeBashGuidance,
    '',
    'How Batshit handles tool results:',
    '- Tool outputs are often zipped quickly to save tokens.',
    '- Never write visible Batshit zip reference syntax, clip reference syntax, or `**(Clip Log: ...)**` lines in your reply — those are Batshit record marks. Refer to "a zip reference", "a clip", or the visible badge in prose instead.',
    toolNotesEnabled
      ? '- Tool Notes are your lightweight memory. Save only the exact facts you will need later.'
      : '- Tool Notes are disabled for this agent/session.',
    '',
    'Zip control (user-only):',
    '- Do NOT include unzip/zip actions or zip-control blocks.',
    `- Ask the user to unzip content if needed, or fetch it when available: ${fetchZipInstruction}`,
    toolNotesEnabled
      ? `- Auto-zipped tools/content can be manually unzipped by the user; you can revisit it with Fetch Zip or your Tool Notes.`
      : `- Auto-zipped tools/content can be manually unzipped by the user; you can revisit it with Fetch Zip.`,
    '- Treat natural-language requests such as "keep this unzipped" or "unzip these memory files" as zip-state requests. Because zip control is disabled for you here, do not include unzip/zip actions; ask the user to unzip from the UI or fetch the zip when you need to re-check it.',
    ...toolNotesGuidance
  ].join('\n')
}

/**
 * Code fallback for the Memory guidance block (SA-104 P3), used only when the Redis
 * prompt key (`batshit:tool_guidance_memory_prompt`) is empty — packaged defaults
 * normally seed it on boot. Injected by the compilation path for memory-enabled
 * agents only; keep the two call sites and this text in sync with the packaged
 * `batshit_tool_prompt_memory.md`.
 */
export function buildMemoryPromptBlock(options?: {
  runtimeFlavor?: 'codex' | 'claude' | 'vercel'
}): string {
  const runtimeFlavor = options?.runtimeFlavor ?? 'vercel'
  const searchTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_search' : 'batshit_tool_search'
  const useTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_use' : 'batshit_tool_use'

  return [
    'You have a persistent memory. What you save now is available in future conversations with you.',
    'Nothing happens to a stored memory unless you explicitly act on it. A new save never edits, replaces, supersedes, or deletes an existing memory by itself; choose those actions deliberately.',
    '',
    'The Three Memory Lanes (types)',
    '(Note: You are responsible for *saving* all three types, but you are only responsible for *surfacing* one type)',
    'Every memory lives in one of three lanes, chosen at save time. Saving is always your job; the lane decides how the memory comes back to you:',
    '1. `awareness` — (Addendum to your main System Prompt)',
    '- Things you should never lose sight of. Surfaces itself, instantly: from your very next message it is active through Awareness updates, then folds into your AWARENESS system-prompt block at the next nap, dream, or new session — no tool call or recall. Saving it IS surfacing it. Supports expiry (expired entries demote, they are never erased). Great for stuff you really need to know (stay aware of) at all times.',
    '2. `stm` — (Short-Term-Memory)',
    '- Trigger Memories (requires trigger_terms). Surfaces itself on cue: the moment a USER message mentions a trigger word, the memory is inserted into your DYNAMIC INFO block automatically — no tool call. (Your own use of the word does not fire it; the scan reads the user\'s messages.) Great for people, pets, projects, and recurring topics.',
    '3. `ltm` — (Long-Term-Memory)',
    '- Searchable memory, the default lane for most facts. The one lane you surface yourself: it comes back only when you go looking with your memory tools (search, then recall). Save here freely — it costs nothing until you fetch it.',
    '',
    'Saving:',
    '- Hot path: append an inline save block at the END of your message (zero tool round-trip):',
    '<batshit-memory>',
    '{"lane":"ltm","content":"the fact, compact and self-contained","importance":6}',
    '</batshit-memory>',
    '- One block per memory; several blocks are fine. Put all normal prose before any control blocks.',
    '- stm saves need trigger_terms, e.g. {"lane":"stm","content":"Maggie is the user\'s Irish Setter","trigger_terms":["maggie"],"importance":7}.',
    '- stm saves may set "linger": how long the memory stays in context after its trigger was last mentioned — turns 0-30, or "episode" to hold for the rest of the current episode; omit for the user-set default.',
    '- `clip_ids` are save/update inputs: Batshit copies those Clip images into memory-owned media. `media_mode:"always"` is Awareness-only and sends those owned images every message; otherwise images arrive on recall.',
    '- Save compact facts, not transcripts. Include when the fact was true via event_at if it differs from now. When the content runs long, add a gist — it becomes the headline in search results.',
    '- A malformed save fails visibly and you get a correction note next turn — fix it then.',
    '- Saying is not saving. "I\'ll keep that in mind" stores nothing — when a fact deserves to survive this conversation, write the save block (or call the save tool) in that same reply. The visible "Memory saved" chip is the proof.',
    '',
    'Keeping memory honest (supersession discipline):',
    '- Update when the same fact needs correction or expansion. Supersede when the fact changed or contradicts another memory; supersession keeps the receipts instead of piling up competing truths.',
    '- The agent chooses which memory remains current; timestamps do not decide. An older canonical memory may supersede a newer duplicate. Superseded memories stay stored and flagged with a pointer to the chosen winner, never deleted.',
    '- If the chosen winner is itself superseded by a memory you want it to replace, unsupersede the winner first. Batshit refuses supersession cycles loudly.',
    '- Saving with "supersedes":["memory_id"] requires the exact id of every memory being replaced. If an id is not already in your current context, call fabric:sys.memory.search or fabric:sys.memory.list first.',
    '- Superseded and expired Awareness entries stop being active immediately. A frozen AWARENESS block may retain its old bytes until the next fold, but Awareness updates tells you to disregard them now and the next fold removes them.',
    '- Delete only what is outright wrong or unwanted; prefer supersede so history keeps its receipts.',
    '',
    `Direct memory operations: call \`${useTool}\` directly with the printed \`fabric:sys.memory.*\` refs below. Never call \`${searchTool}\` for memory operations; these refs are already known tools.`,
    '- `fabric:sys.memory.search` — hybrid search with lane and time-range filters; returns summary references only, ranked by relevance × recency × importance (rows marked linked_from rode in via another result\'s links).',
    '- `fabric:sys.memory.recall` — read chosen memory ids in full. The complete content returns immediately in the tool result — use it in this same reply. That tool result never enters chat history; the same memories then ride your Memory context from the next message onward and linger (that is the handoff). Photos: supported API models and Codex CLI receive recalled images during this same reply, either in the tool result or in a follow-up model input within this reply — look at them now. Claude CLI and other deferred images use the next-message REMEMBERED MEDIA path. Each memory\'s media_note says which happened.',
    '- `fabric:sys.memory.list` / `update` / `supersede` / `unsupersede` / `move_lane` / `delete` — maintenance operations.',
    '- Search results alone are just references; recall is the read.',
    '',
    'Episodes, naps, and the whiteboard (Infinite Sessions only):',
    '- `fabric:sys.memory.close_episode` — mark the current work chapter finished at a real boundary; a new episode opens on the next message, and closed episodes graduate later (nothing is deleted).',
    '- `fabric:sys.memory.hold_episode` — keep the current episode open across idle gaps ("continue tomorrow"): pass hold_until (ISO) or null to clear. Without a hold, a long break closes the episode on its own.',
    '- `fabric:sys.memory.whiteboard` — rewrite your EPISODE WHITEBOARD: working facts (goal, decisions, live state, open items) that arrive with every current message (the `Episode whiteboard` section) until the episode closes. Pass the complete new content, or null to clear. All three controls error outside Infinite Sessions.',
    '- When the window grows near its limit, Batshit naps between turns: closed episodes graduate to searchable memory (a gist stays in the window), stale tool bulk compresses, and if needed the oldest open-episode narrative is summarized with your whiteboard refreshed. Recent conversation never graduates — the floor is guaranteed.',
    '- Between conversations your memory dreams: near-duplicates consolidate (provenance kept), supersession chains get repaired, expiries demote (never erase), and closed episodes graduate overnight. The superseded_by pointer is authoritative: for example, if memory A points to winner B but a crashed write left B\'s supersedes list missing A, dreaming adds that missing reverse link. Every action is logged for the user with its reason. Do not spend live turns on bulk memory reorganization; maintenance happens while you rest.',
    '- Never claim a memory or episode action you did not perform — the tool call is the act, and the visible records (chips, the episode line, nap and dreaming logs) are what the user checks.',
    '',
    'How remembered content reaches you:',
    '- Inserted memories appear in the `Memory context:` section of your DYNAMIC INFO block, grouped as Current (new this message) and Lingering (from earlier messages). Inserts linger after their last relevance, then drop out (✅ new, ✳️ refreshed, 🟢 lingering). Trigger and recall inserts have separate user-set linger defaults; a Trigger Memory\'s own "linger" setting beats the default.',
    '- Your awareness entries compile into the AWARENESS section of your system prompt instead; new or changed entries take effect immediately, riding the `Awareness updates` section of your current message until they fold into the AWARENESS block at the next nap, dream, or new session. Owned images with `media_mode:"always"` arrive under AWARENESS MEDIA every message as standing context; other images arrive on recall.',
    '- Need something recalled to stay around for a stretch of work? Promote it: move it to awareness (`sys.memory.move_lane`), pin it on the episode whiteboard, or give the Trigger Memory "linger":"episode" rather than re-recalling forever.',
    '- Insert lanes are budgeted; a `More available:` line tells you when matches were left out.',
    '- Search results may include a `segments` group: graduated conversation stretches. Recall a segment id (memseg_…) exactly like a memory id to receive that episode\'s full summary.',
    '- In group chats your saves and memory tools work, but automatic inserts (triggers, recalls, Awareness) are active only in single-agent sessions for now.',
    '',
    'Everything you store is fully visible to the user in their Memory Panel — memory is shared ground truth, never a private notebook.'
  ].join('\n')
}

const LEGACY_DYNAMIC_FIND_PATTERN = /\bbatshit_server_dynamic_mcp_find\b/g
const LEGACY_DYNAMIC_USE_PATTERN = /\bbatshit_server_dynamic_mcp_use\b/g

export function normalizeDynamicMcpPromptContent(prompt: string): string {
  if (!prompt) return ''
  return prompt
    .replace(LEGACY_DYNAMIC_FIND_PATTERN, 'native_batshit_tool_search')
    .replace(LEGACY_DYNAMIC_USE_PATTERN, 'native_batshit_tool_use')
}

/**
 * Code fallback for the Dynamic Tool Search / Discovery block, used only when the Redis
 * prompt key is empty (packaged defaults normally seed it on boot).
 *
 * SA-096: this is now the single home for broker guidance in the fallback lane too — the
 * tool + zip fallback used to restate it. It is runtime-aware for the same reason the
 * packaged prompt is: an API agent must never be taught `batshit_tool_use`, which it does
 * not have.
 */
export function buildDynamicMcpPromptBlock(options?: {
  runtimeFlavor?: 'codex' | 'claude' | 'vercel'
}): string {
  const runtimeFlavor = options?.runtimeFlavor ?? 'vercel'
  const searchTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_search' : 'batshit_tool_search'
  const useTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_use' : 'batshit_tool_use'

  return [
    'Dynamic Tool Search lets you discover and use Batshit capabilities without loading huge tool lists into context.',
    '',
    'If a tool is already in your tool list, call it directly — never search for it; search is for capabilities beyond that list.',
    '- Web Search: call the Web Search tool directly.',
    '- Bash: call the Bash tool directly.',
    '- Skills: call `native_skill` directly.',
    '- Your named subagents: call their tools directly.',
    '- The Dynamic Tool Search/Use pair itself: call it directly.',
    '- If `tool_discovery` gives an exact typed ref plus enough schema hint detail for a safe call, pass that ref straight to the use tool; a prior search is not required.',
    '',
    `Your broker pair is \`${searchTool}\` / \`${useTool}\`.`,
    `Do not call \`native_skill\` with \`skillId="${searchTool}"\` or \`skillId="${useTool}"\`; these are tools, not skills.`,
    '',
    'Families (the ref prefix matters):',
    '- `mcp:...` user-installed MCP gateway tools',
    '- `cli:...` saved Batshit CLI tools — their own lane, not raw shell commands',
    '- `artifact:...` published artifact runtime tools',
    '- `fabric:...` Batshit control-plane actions when this actor is allowed broad Fabric',
    '- `agent_browser:...` Agent Browser actions where the runtime supports them',
    '',
    'Prefer the broker over bash for any of those families when it is available.',
    '',
    'Rules:',
    '- Search with `family` when you know the lane, then copy the exact returned `ref` into the use call.',
    '- Never invent placeholder refs such as "selected".',
    '- Keep capability-specific arguments inside `input`; never flatten required fields to the top level. If the schema says `inputFile`, pass `input.inputFile`.',
    '- Compact schema hints are the default; request the full schema only when they are not enough or the action may be destructive.',
    '- If a call fails because a required field is missing, inspect the schema/result and retry with the exact field names.',
    '',
    'Hints are guidance, not authorization: backend validation, scope checks, risk gates, and artifact allowlists remain authoritative.',
    'Bash, Web Search, Fetch Zip, and `native_skill` are separate primitives. Do not route them through Dynamic Tool Search.'
  ].join('\n')
}
