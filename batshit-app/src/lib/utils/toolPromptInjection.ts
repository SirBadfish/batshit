export function buildToolGuidanceZipPromptBlock(options?: {
  runtimeFlavor?: 'codex' | 'claude' | 'vercel' | 'n8n'
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

  if (zipPermission === 'agent') {
    return [
      `Runtime: ${runtimeFlavor} | ${viewLine}`,
      '',
      ...nativeBashGuidance,
      '',
      'How Batshit handles tool results:',
      '- Tool outputs are often zipped quickly to save tokens.',
      '- Never write visible Batshit zip or clip reference syntax in your reply. Refer to "a zip reference", "a clip reference", or the visible badge in prose instead.',
      toolNotesEnabled
        ? '- Tool Notes are lightweight memory. Save only the exact facts you will need after the raw result disappears.'
        : '- Tool Notes are disabled for this agent/session.',
      '- Tool Results Summary is Batshit app metadata, not private reasoning and not a place for private instructions. Keep it short, factual, and limited to information the user could inspect from the tool result.',
      '- Transparency: Tool Results Summary notes are user-visible in Batshit through an expandable summary panel on the assistant message. Zip/unzip controls also leave visible state through zip badges and expanded/collapsed content. Use these features for token management and continuity, not to hide information from the user.',
      '',
      'Zip control (permission ON):',
      '- Treat natural-language requests as zip-control requests. If the user or their custom instructions say things like "keep this unzipped," "unzip these memory files," "leave this tool output available," or "pin this context," use the `unzip` control when zip control is enabled; the user does not need to mention Batshit zip control or the control-block syntax.',
      '- `unzip`: for tool results from this response, use `tool_result_N` where N is the 1-based result number (`tool_result_1`, `tool_result_2`, `tool_result_3`, ...).',
      '- Never use `tool_result_0`; numbering starts at 1.',
      '- For older zips already visible in chat history, use the actual zip ID from the zip index/reference.',
      '- `zip`: use zip IDs for content you are done with and want compressed again. Do not zip user-locked items.',
      '- Use `toolResultsSummary` for short factual notes when a summary is enough.',
      toolNotesEnabled
        ? `- Need to read a zip right now? ${fetchZipInstruction} It peeks without changing zip state. If it should stay available after this response, also put its zip ID in \`unzip\` and save important facts in Tool Notes.`
        : `- Need to read a zip right now? ${fetchZipInstruction} It peeks without changing zip state. If it should stay available after this response, also put its zip ID in \`unzip\`.`,
      '- Changes apply on the next user message.',
      '',
      'Only append a zip-control block when you actually need to change zip state or save Tool Notes.',
      'Do not append an empty zip-control block. If there are no zip changes and no useful Tool Notes, omit the block entirely.',
      'Put all normal spoken prose before `<batshit-zip-control>`; the zip-control block must be the final thing in your message.',
      'Never output the JSON by itself; it must be wrapped in `<batshit-zip-control>` and `</batshit-zip-control>`.',
      'Do not write any visible reply text after `</batshit-zip-control>`, especially in Voice Mode because later text may not be spoken aloud reliably.',
      'Batshit strips the raw XML/JSON syntax from normal chat rendering, but its effects are visible in the UI.',
      'Zip-control block examples (append after your normal response):',
      '<batshit-zip-control>',
      toolNotesEnabled
        ? '{"unzip":["tool_result_1","tool_result_3"],"zip":["zipId"],"toolResultsSummary":[{"toolName":"...","summary":"exact fact(s) to retain"}]}'
        : '{"unzip":["tool_result_1","tool_result_3"],"zip":["zipId"]}',
      '</batshit-zip-control>'
    ].join('\n')
  }

  return [
    `Runtime: ${runtimeFlavor} | ${viewLine}`,
    '',
    ...nativeBashGuidance,
    '',
    'How Batshit handles tool results:',
    '- Tool outputs are often zipped quickly to save tokens.',
    '- Never write visible Batshit zip or clip reference syntax in your reply. Refer to "a zip reference", "a clip reference", or the visible badge in prose instead.',
    toolNotesEnabled
      ? '- Tool Notes are your lightweight memory. Save only the exact facts you will need later.'
      : '- Tool Notes are disabled for this agent/session.',
    '- Tool Results Summary is Batshit app metadata, not private reasoning and not a place for private instructions. Keep it short, factual, and limited to information the user could inspect from the tool result.',
    '- Transparency: Tool Results Summary notes are user-visible in Batshit through an expandable summary panel on the assistant message. Use summaries for token management and continuity, not to hide information from the user.',
    '',
    'Zip control (user-only):',
    '- Do NOT include unzip/zip actions.',
    `- Ask the user to unzip content if needed, or fetch it when available: ${fetchZipInstruction}`,
    toolNotesEnabled
      ? `- Auto-zipped tools/content can be manually unzipped by the user; you can revisit it with Fetch Zip or your Tool Notes.`
      : `- Auto-zipped tools/content can be manually unzipped by the user; you can revisit it with Fetch Zip.`,
    '- Treat natural-language requests such as "keep this unzipped" or "unzip these memory files" as zip-state requests. Because zip control is disabled for you here, do not include unzip/zip actions; ask the user to unzip from the UI or fetch the zip when you need to re-check it.',
    ...(toolNotesEnabled
      ? [
          '',
          'Only append a zip-control block when you need to save Tool Notes.',
          'Do not append an empty zip-control block. If there are no useful Tool Notes, omit the block entirely.',
          'Put all normal spoken prose before `<batshit-zip-control>`; the zip-control block must be the final thing in your message.',
          'Never output the JSON by itself; it must be wrapped in `<batshit-zip-control>` and `</batshit-zip-control>`.',
          'Do not write any visible reply text after `</batshit-zip-control>`, especially in Voice Mode because later text may not be spoken aloud reliably.',
          'Batshit strips the raw XML/JSON syntax from normal chat rendering, then shows the summaries through the expandable Tool Results Summary panel.',
          'Zip-control block example (summaries only):',
          '<batshit-zip-control>',
          '{"toolResultsSummary":[{"toolName":"...","summary":"exact fact(s) to retain"}]}',
          '</batshit-zip-control>'
        ]
      : [])
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
  runtimeFlavor?: 'codex' | 'claude' | 'vercel' | 'n8n'
}): string {
  const runtimeFlavor = options?.runtimeFlavor ?? 'vercel'
  const isN8n = runtimeFlavor === 'n8n'
  const searchTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_search' : 'batshit_tool_search'
  const useTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_use' : 'batshit_tool_use'

  return [
    'Dynamic Tool Search lets you discover and use Batshit capabilities without loading huge tool lists into context.',
    '',
    ...(isN8n
      ? [
          `Your broker lives on the \`Batshit Tools\` node. Use \`action="${searchTool}"\` and \`action="${useTool}"\`. These are action names for that node, not standalone skills.`
        ]
      : [`Your broker pair is \`${searchTool}\` / \`${useTool}\`.`]),
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
    ...(isN8n
      ? ['- When CLI scope is available, pass/retain `selectedToolIds` so the backend can enforce the discoverable CLI lane.']
      : []),
    '',
    'Hints are guidance, not authorization: backend validation, scope checks, risk gates, and artifact allowlists remain authoritative.',
    'Bash, Web Search, Fetch Zip, and `native_skill` are separate primitives. Do not route them through Dynamic Tool Search.'
  ].join('\n')
}
