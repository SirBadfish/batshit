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
  const toolSearchTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_search' : 'batshit_tool_search'
  const toolUseTool = runtimeFlavor === 'vercel' ? 'native_batshit_tool_use' : 'batshit_tool_use'
  const fetchZipInstruction =
    runtimeFlavor === 'codex' || runtimeFlavor === 'claude'
      ? `Use \`batshit_server_fetch_zip\` when directly available, or ${toolUseTool} with ref="fabric:sys.zip.fetch" when the broker exposes it.`
      : `Use ${toolUseTool} with ref="fabric:sys.zip.fetch".`
  const cliGuidance =
    runtimeFlavor === 'n8n'
      ? [
          'CLI tools (when discoverable for this agent):',
          '- Batshit CLI tools are their own tool lane. They are not raw shell commands and they are not standalone skills.',
          '- In n8n modes, use the single `Batshit Tools` tool node.',
          '- Set action="batshit_tool_search" with family="cli" when you need the tool id or schema.',
          '- Set action="batshit_tool_use" with the exact `cli:` ref when you are ready to run it.',
          '- Put manifest-specific fields inside the nested input object.',
          '- When CLI scope is available, pass/retain `selectedToolIds` so the backend can enforce the discoverable CLI lane.',
          '- Do not call `native_skill` with `skillId="batshit_tool_search"` or `skillId="batshit_tool_use"`; those are not skills.',
          '- If the schema says a required field is `inputFile`, keep it inside `input.inputFile`.'
        ]
      : [
    'CLI tools (when discoverable for this agent):',
    '- Treat Batshit CLI tools as their own tool lane, not as raw shell commands.',
    `- If a CLI tool is discoverable for the task, prefer ${toolSearchTool} / ${toolUseTool} over bash for that task.`,
    `- First use ${toolSearchTool} with family="cli" and schemaMode="full" when you need required input fields or the exact toolId.`,
    `- Then call ${toolUseTool} with the exact cli: ref and keep manifest fields inside the nested input object.`,
    '- Do not invent placeholder tool ids such as "selected".',
    '- Do not flatten required manifest fields to the top level; if the schema says inputFile, pass it inside input.',
    '- If the first CLI-tool call fails because a required field is missing, inspect the schema/result and retry with the exact field names.'
        ]

  if (zipPermission === 'agent') {
    return [
      `Runtime: ${runtimeFlavor} | ${viewLine}`,
      '',
      ...cliGuidance,
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
        ? `- Need to read an older zip right now? ${fetchZipInstruction} If it should stay available after this response, also put its zip ID in \`unzip\` and save important facts in Tool Notes.`
        : `- Need to read an older zip right now? ${fetchZipInstruction} If it should stay available after this response, also put its zip ID in \`unzip\`.`,
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
      '</batshit-zip-control>',
      '',
      `Backup option: ${fetchZipInstruction} This peeks at a zip without changing state.`
    ].join('\n')
  }

  return [
    `Runtime: ${runtimeFlavor} | ${viewLine}`,
    '',
    ...cliGuidance,
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

export function buildDynamicMcpPromptBlock(): string {
  return [
    'Dynamic Tool Search is enabled for MCP gateway tools:',
    '- Use `native_batshit_tool_search({ family: "mcp", query })` to search user gateways by keyword or MCP Group.',
    '- Use `native_batshit_tool_use({ ref: "mcp:exact_tool_name", input: { ... } })` to execute a discovered MCP tool.',
    '- Keep the exact `mcp:` ref returned by search; do not drop or rewrite the prefix.',
    '',
    'Use exact call shapes to avoid failed round trips:',
    '- Preferred search: `native_batshit_tool_search({ family: "mcp", query: "postgres", schemaMode: "compact" })`',
    '- Preferred use: `native_batshit_tool_use({ ref: "mcp:tool_name", input: { ... } })`',
    '- Required: keep target tool arguments inside `input` (not top-level).',
    '',
    'Use this when you need a tool that is not currently enabled, without bloating context with huge tool lists.'
  ].join('\n')
}
