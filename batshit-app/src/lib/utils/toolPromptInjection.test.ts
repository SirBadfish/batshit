import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildDynamicMcpPromptBlock, buildToolGuidanceZipPromptBlock } from './toolPromptInjection'

describe('buildToolGuidanceZipPromptBlock', () => {
  it('defaults the AI zip view to appended', () => {
    expect(buildToolGuidanceZipPromptBlock()).toContain('Zip AI view: appended')
  })

  it('honors an explicit inline AI zip view', () => {
    expect(buildToolGuidanceZipPromptBlock({ zipAiViewMode: 'inline' })).toContain(
      'Zip AI view: inline'
    )
  })

  it('teaches one-based current tool result aliases when agent control is enabled', () => {
    const prompt = buildToolGuidanceZipPromptBlock({ zipControlPermission: 'agent' })

    expect(prompt).toContain('Treat natural-language requests as zip-control requests')
    expect(prompt).toContain('the user does not need to mention Batshit zip control')
    expect(prompt).toContain('use `tool_result_N`')
    expect(prompt).toContain('Never use `tool_result_0`')
    expect(prompt).toContain('"unzip":["tool_result_1","tool_result_3"],"zip":["zipId"]')
    expect(prompt).toContain('not private reasoning and not a place for private instructions')
    expect(prompt).toContain('Tool Results Summary notes are user-visible')
    expect(prompt).toContain('Batshit strips the raw XML/JSON syntax')
    expect(prompt).not.toContain('keepUnzipped')
    expect(prompt).not.toContain('rezip')
    expect(prompt).not.toContain('toolCallId list')
    expect(prompt).not.toContain('"keepUnzipped":["toolCallId"]')
  })

  it('keeps the packaged zip-enabled Admin reset prompt aligned with tool result aliases', () => {
    const prompt = readFileSync(
      resolve(
        process.cwd(),
        '../docs/batshit_System_Prompts/batshit_tool_prompt_zip_control_enabled.md'
      ),
      'utf8'
    )

    expect(prompt).toContain('use `tool_result_N`')
    expect(prompt).toContain('Never use `tool_result_0`')
    expect(prompt).toContain('Treat natural-language requests as zip-control requests')
    expect(prompt).toContain('not private reasoning and not a place for private instructions')
    expect(prompt).toContain('Tool Results Summary notes are user-visible')
    expect(prompt).toContain('raw XML/JSON syntax is stripped')
    expect(prompt).toContain('"unzip":["tool_result_1","tool_result_3"],"zip":["zipId"]')
    expect(prompt).not.toContain('hidden block')
    expect(prompt).not.toContain('Use `zipId` for every zip-control action.')
  })

  it('keeps natural unzip requests explicit when zip control is user-only', () => {
    const prompt = buildToolGuidanceZipPromptBlock({ zipControlPermission: 'user' })

    expect(prompt).toContain('Treat natural-language requests such as "keep this unzipped"')
    expect(prompt).toContain('Because zip control is disabled for you here')
    expect(prompt).toContain('Do NOT include unzip/zip actions')
  })

  it('keeps the packaged zip-disabled Admin reset prompt aligned with user-only zip control', () => {
    const prompt = readFileSync(
      resolve(
        process.cwd(),
        '../docs/batshit_System_Prompts/batshit_tool_prompt_zip_control_disabled.md'
      ),
      'utf8'
    )

    expect(prompt).toContain('Treat natural-language requests such as "keep this unzipped"')
    expect(prompt).toContain('Because zip control is disabled for you here')
    expect(prompt).toContain('Do NOT include unzip/zip action arrays')
    expect(prompt).toContain('not private reasoning and not a place for private instructions')
    expect(prompt).toContain('Tool Results Summary notes are user-visible')
    expect(prompt).toContain('shows the summaries through the expandable Tool Results Summary panel')
    expect(prompt).not.toContain('Never show this block to the user')
  })

  it('teaches broker-first CLI tool use in fallback tool prompt', () => {
    const prompt = buildToolGuidanceZipPromptBlock()

    expect(prompt).toContain('native_batshit_tool_search')
    expect(prompt).toContain('native_batshit_tool_use')
    expect(prompt).toContain('family="cli"')
    expect(prompt).toContain('cli: ref')
    expect(prompt).not.toContain('native_cli_tool_find')
    expect(prompt).not.toContain('native_cli_tool_use')
  })

  it('teaches broker-first MCP discovery in the Dynamic MCP fallback prompt', () => {
    const prompt = buildDynamicMcpPromptBlock()

    expect(prompt).toContain('native_batshit_tool_search')
    expect(prompt).toContain('family: "mcp"')
    expect(prompt).toContain('ref: "mcp:exact_tool_name"')
    expect(prompt).not.toContain('native_dynamic_mcp_find')
    expect(prompt).not.toContain('native_dynamic_mcp_use')
  })
})
