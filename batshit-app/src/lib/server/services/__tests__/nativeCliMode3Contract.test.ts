import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createCliTool } from '$lib/server/services/cliToolRegistry'
import { nativeToolService } from '../nativeTools'

useRedisTestServer()

vi.mock('$env/dynamic/private', () => ({
  env: {
    BATSHIT_ENABLE_AGENT_BROWSER: 'false'
  }
}))

// Real-Redis suite (G-0228): this file intentionally restores the REAL $lib/server/redis
// module via vi.importActual, so it runs only under `npm run test:redis`
// (VITEST_USE_REAL_REDIS=true) and reports as skipped in the default mocked lane.
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('Mode 3 CLI tool contract', () => {
  let userId = 'mode3-cli-contract-user'
  let toolId = 'file_probe'
  let agentId = 'mode3-cli-contract-agent'

  beforeEach(async () => {
    const suffix = Math.random().toString(36).slice(2, 8)
    userId = `mode3-cli-contract-user-${suffix}`
    toolId = `file_probe_${suffix}`
    agentId = `mode3-cli-contract-agent-${suffix}`

    await redis.createAgent({
      id: agentId,
      user_id: userId,
      displayName: 'Mode 3 Contract Agent',
      agentType: 'batshit',
      batshitMode: 'direct',
      defaultTools: [toolId]
    })

    await createCliTool(userId, {
      toolId,
      title: 'File Probe',
      description: 'Echoes the provided input file path as JSON.',
      tags: ['file', 'probe'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [
        { kind: 'literal', value: '-e' },
        {
          kind: 'literal',
          value: 'process.stdout.write(JSON.stringify({ inputFile: process.argv[1] }))'
        },
        { kind: 'input', field: 'inputFile', required: true }
      ],
      inputSchema: {
        type: 'object',
        properties: {
          inputFile: {
            type: 'string',
            required: true,
            format: 'path',
            description: 'Absolute path to inspect'
          }
        },
        required: ['inputFile']
      },
      outputMode: 'json',
      parseMode: 'json',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: false,
      validationInput: {
        inputFile: '/tmp/example'
      }
    })
  })

  it('shows schema details and an exact nested-input example in Batshit tool search model output', async () => {
    const tools = await nativeToolService.buildMode3NativeTools({
      userId,
      selectedCliToolIds: [toolId]
    } as any)

    const searchTool = (tools as any).native_batshit_tool_search
    expect(searchTool).toBeTruthy()

    const output = await searchTool.execute({
      query: 'probe',
      family: 'cli',
      schemaMode: 'full'
    })
    const modelOutput = await searchTool.toModelOutput({ output })

    expect(String(modelOutput.value)).toContain('inputFile')
    expect(String(modelOutput.value)).toContain(`cli:${toolId}`)
    expect(String(modelOutput.value)).toContain('native_batshit_tool_use')
    expect(String(modelOutput.value)).toContain('input: { inputFile: "<string>" }')
  })

  it('repairs top-level manifest fields when using an exact cli: ref through Batshit tool use', async () => {
    const tools = await nativeToolService.buildMode3NativeTools({
      userId,
      selectedCliToolIds: [toolId]
    } as any)

    const useTool = (tools as any).native_batshit_tool_use
    expect(useTool).toBeTruthy()

    const result = await useTool.execute({
      ref: `cli:${toolId}`,
      inputFile: '/tmp/real-file'
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.toolId).toBe(toolId)
      expect(result.ref).toBe(`cli:${toolId}`)
      expect(result.family).toBe('cli')
      expect(result.operationKind).toBe('cli_tool')
      expect(result.parsedOutput).toEqual({ inputFile: '/tmp/real-file' })
    }
  })
})
