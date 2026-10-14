import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  getSessionMessages: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

import {
  estimateCodexProjectInstructionChars,
  estimateCodexProjectInstructionTokens,
  resolveContextPreviewMessages,
  resolveAgentBudgetSettings,
  resolveCodexProjectDocMaxBytes
} from '$lib/server/services/contextTokenPreview'
import { countTotalTokens } from '$lib/utils/tokenCounter'

const tempDirs: string[] = []

beforeEach(() => {
  for (const key of ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) vi.stubEnv(key, '')
})

async function createTempProject() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-context-preview-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.unstubAllEnvs()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('context preview message source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses stored session messages when the client requests a post-save preview', async () => {
    redisMock.getSessionMessages.mockResolvedValue([
      {
        id: 'stored-assistant',
        session_id: 'session-1',
        user_id: 'user-1',
        role: 'assistant',
        content: '{{batshit-zip:zip_1:::Saved tool result}}',
        created_at: '2026-06-01T00:00:00.000Z'
      }
    ])

    const messages = await resolveContextPreviewMessages({
      sessionId: 'session-1',
      providedMessages: [
        {
          id: 'client-assistant',
          session_id: 'session-1',
          user_id: 'user-1',
          role: 'assistant',
          content: 'A'.repeat(20_000),
          created_at: '2026-06-01T00:00:00.000Z'
        }
      ],
      useStoredMessages: true
    })

    expect(redisMock.getSessionMessages).toHaveBeenCalledWith('session-1')
    expect(messages.map((message) => message.id)).toEqual(['stored-assistant'])
    expect(messages[0]?.content).toContain('{{batshit-zip:zip_1')
  })

  it('keeps using provided client messages for normal local context-control previews', async () => {
    const messages = await resolveContextPreviewMessages({
      sessionId: 'session-1',
      providedMessages: [
        {
          id: 'client-user',
          session_id: 'session-1',
          user_id: 'user-1',
          role: 'user',
          content: 'Current in-memory trimmed view',
          created_at: '2026-06-01T00:00:00.000Z'
        }
      ],
      useStoredMessages: false
    })

    expect(redisMock.getSessionMessages).not.toHaveBeenCalled()
    expect(messages.map((message) => message.id)).toEqual(['client-user'])
  })
})

describe('context token preview', () => {
  it('uses the chosen CLI model and the instance 1M cap for send preflight', async () => {
    redisMock.get.mockResolvedValue(null)
    const agent = {
      primary_model_preset_id: null,
      primary_model_provider: 'anthropic-claude-cli',
      primary_model_name: 'claude-cli',
      primary_model_connection: { type: 'direct', service: 'anthropic-claude-cli' },
      claude_settings: { permissionMode: 'default', model: 'sonnet[1m]' }
    }
    expect((await resolveAgentBudgetSettings(agent)).contextLimit).toBe(1_000_000)
    vi.stubEnv('CLAUDE_CODE_DISABLE_1M_CONTEXT', '1')
    expect((await resolveAgentBudgetSettings(agent)).contextLimit).toBe(200_000)
  })
  it('resolves Codex project_doc_max_bytes from custom config overrides', () => {
    expect(
      resolveCodexProjectDocMaxBytes({
        codex_settings: {
          permissionMode: 'agent_full',
          model: 'gpt-5.5',
          addDirs: [],
          enableFeatures: [],
          disableFeatures: [],
          configOverrides: [{ key: 'project_doc_max_bytes', value: '150000' }]
        }
      })
    ).toBe(150000)
  })

  it('estimates Codex project instructions using the active byte cap', async () => {
    const projectPath = await createTempProject()
    await writeFile(path.join(projectPath, 'AGENTS.md'), 'A'.repeat(64), 'utf8')

    const tokens = await estimateCodexProjectInstructionTokens({
      projectPath,
      agent: {
        codex_settings: {
          permissionMode: 'agent_full',
          model: 'gpt-5.5',
          includeProjectInstructions: true,
          addDirs: [],
          enableFeatures: [],
          disableFeatures: [],
          configOverrides: [{ key: 'project_doc_max_bytes', value: '16' }]
        }
      }
    })

    expect(tokens).toBe(
      countTotalTokens([
        {
          role: 'system',
          content: 'A'.repeat(16)
        }
      ])
    )
  })

  it('estimates Codex project instruction characters using the active byte cap', async () => {
    const projectPath = await createTempProject()
    await writeFile(path.join(projectPath, 'AGENTS.md'), 'A'.repeat(64), 'utf8')

    const chars = await estimateCodexProjectInstructionChars({
      projectPath,
      agent: {
        codex_settings: {
          permissionMode: 'agent_full',
          model: 'gpt-5.5',
          includeProjectInstructions: true,
          addDirs: [],
          enableFeatures: [],
          disableFeatures: [],
          configOverrides: [{ key: 'project_doc_max_bytes', value: '16' }]
        }
      }
    })

    expect(chars).toBe(16)
  })

  it('does not count project instructions when Codex project instructions are disabled', async () => {
    const projectPath = await createTempProject()
    await writeFile(path.join(projectPath, 'AGENTS.md'), 'A'.repeat(64), 'utf8')

    await expect(
      estimateCodexProjectInstructionTokens({
        projectPath,
        agent: {
          codex_settings: {
            permissionMode: 'agent_full',
            model: 'gpt-5.5',
            includeProjectInstructions: false,
            addDirs: [],
            enableFeatures: [],
            disableFeatures: [],
            configOverrides: [{ key: 'project_doc_max_bytes', value: '150000' }]
          }
        }
      })
    ).resolves.toBe(0)
  })
})
