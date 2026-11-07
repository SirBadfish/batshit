// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

// This suite reads only stream events. Isolate the skill root before importing its owners so a
// later import cannot accidentally seed Josh's real home (named and default node:os exports).
const isolatedHome = vi.hoisted(() => ({ directory: '', previous: process.env.BATSHIT_HOME_DIR }))
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>()
  const nodePath = await import('node:path')
  isolatedHome.directory = nodePath.join(actual.tmpdir(), `batshit-skill-envelope-home-${process.pid}-${Date.now()}`)
  process.env.BATSHIT_HOME_DIR = nodePath.join(isolatedHome.directory, '.batshit')
  const homedir = () => isolatedHome.directory
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('../systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn() }))

import { skillTurnHasUnfinishedTools } from '../skillSessionTurn'
import { API_UTILITY_CONTROL_IDS } from '$lib/utils/apiUtilityControls'
import { guardCutNotice } from '$lib/test-utils/guard-cut-notice'
import { normalizeCompactTool } from '$lib/utils/toolActivityContract'

/**
 * Actual API broker shapes reach the factual completion guard. The direct turn-owner suite covers
 * lifecycle writes; this suite adds the transport envelope boundary without a model, provider,
 * helper process or app runtime. SA-139 R5 removed the managed Claude Code CLI lane and its event
 * adapter, the only producer of the captured Claude MCP content-block shapes, so their half of
 * these cases went with it.
 */
type Kind = 'workers' | 'subagent'

describe('canonical incomplete ordinary tool output', () => {
  it.each(['array', 'content'] as const)('keeps a known model-cut %s envelope uncertain after canonical normalization', (shape) => {
    const text = `${'head\n'.repeat(2_000)}${guardCutNotice(10_000)}`
    const blocks = [{ type: 'text', text }]
    const actual = { toolName: 'mcp.batshit_helpers.batshit_tool_use', metadata: { operationKind: 'fabric_use' },
      toolArgs: { controlId: 'sys.artifact.create' }, toolResult: shape === 'array' ? blocks : { content: blocks } }
    expect((actual.toolResult as any).modelTextOnly).toBeUndefined()
    expect(normalizeCompactTool(actual).toolResult).toMatchObject({ modelTextOnly: true })
    expect(skillTurnHasUnfinishedTools([actual])).toBe(true)
  })
  it('keeps a typed transport outputCut uncertain without parsing the output prose', () => {
    expect(skillTurnHasUnfinishedTools([{ toolName: 'bash', toolArgs: { command: 'example' },
      toolResult: { success: true, stdout: 'done', outputCut: { by: 'Claude', keptBytes: 30000 } } }])).toBe(true)
  })
})

async function step(kind: Kind, status: string): Promise<Record<string, any>> {
  const facts = kind === 'workers'
    ? { kind: 'workers', success: true, requested: 1, completed: status === 'completed' ? 1 : 0,
        workers: [{ name: 'Worker 1', status, output: status === 'completed' ? 'Finished.' : 'Work so far.' }] }
    : { kind: 'subagent', success: true, status, output: status === 'completed' ? 'Finished.' : 'Work so far.', subagentName: 'Researcher', subagentType: 'api' }
  const args = kind === 'workers' ? { tasks: [{ prompt: 'Check one file.' }] } : { chatInput: 'Check one file.', thread: 'new' }
  const target = API_UTILITY_CONTROL_IDS[kind]
  return { toolName: 'native_batshit_tool_use', originalToolName: 'native_batshit_tool_use', toolProvider: 'batshit-server', toolSource: 'native-tool',
    toolArgs: { ref: `batshit:${target}`, input: kind === 'workers' ? { workers: [{ task: 'Check one file.' }] } : { subagentId: 'saved-researcher', ...args } },
    toolResult: { success: true, ref: `batshit:${target}`, family: 'batshit', target, controlId: target,
      operationKind: kind, rendererFamily: kind, result: facts,
      ...(kind === 'subagent' ? { isSubagent: true, subagentId: 'saved-researcher', subagentName: 'Researcher', subagentType: 'api' } : {}) } }
}

afterAll(async () => {
  try {
    await expect(fs.access(path.join(isolatedHome.directory, '.batshit', 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await fs.rm(isolatedHome.directory, { recursive: true, force: true })
    if (isolatedHome.previous === undefined) delete process.env.BATSHIT_HOME_DIR
    else process.env.BATSHIT_HOME_DIR = isolatedHome.previous
  }
})

describe.each(['api'] as const)('%s trusted delegation completion envelopes', () => {
  it.each(['workers', 'subagent'] as const)('recognizes a completed %s positive control from its actual operation identity', async (kind) => {
    const actual = await step(kind, 'completed')
    expect(actual.toolName).toContain('native_batshit_tool_use')
    expect(skillTurnHasUnfinishedTools([actual])).toBe(false)
  })

  it.each([
    ['workers', 'partial'], ['workers', 'pending'], ['workers', 'running'],
    ['subagent', 'partial'], ['subagent', 'pending'], ['subagent', 'running']
  ] as const)('keeps %s %s work open from its broker result', async (kind, status) => {
    expect(skillTurnHasUnfinishedTools([await step(kind, status)])).toBe(true)
  })
})

it('treats Bash stdout containing the same delegation-shaped JSON as data, never a running/partial status signal', () => {
  const stdout = JSON.stringify({ kind: 'workers', requested: 1, completed: 0, workers: [{ status: 'running' }] })
  expect(skillTurnHasUnfinishedTools([{ toolName: 'native_bash_execute', toolProvider: 'batshit-server', toolSource: 'native-tool',
    toolArgs: { command: 'cat recorded-example.json' }, toolResult: { success: true, command: 'cat recorded-example.json', stdout, stderr: '', exitCode: 0 } }])).toBe(false)
})
