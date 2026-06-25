import { describe, expect, it } from 'vitest'

import {
  LAST_PROJECT_BY_AGENT_STORAGE_KEY,
  readLastProjectByAgent,
  rememberLastProjectForAgent,
  resolveProjectIdForAgent
} from './projectAgentMemory'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))

  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    }
  }
}

describe('projectAgentMemory', () => {
  it('stores last selected project per agent', () => {
    const storage = memoryStorage()

    rememberLastProjectForAgent('agent-a', 'project-1', storage)
    rememberLastProjectForAgent('agent-b', 'project-2', storage)

    expect(readLastProjectByAgent(storage)).toEqual({
      'agent-a': 'project-1',
      'agent-b': 'project-2'
    })
  })

  it('ignores corrupt storage and stale remembered project ids', () => {
    const storage = memoryStorage({
      [LAST_PROJECT_BY_AGENT_STORAGE_KEY]: '{not json'
    })

    expect(readLastProjectByAgent(storage)).toEqual({})
    expect(
      resolveProjectIdForAgent({
        agentId: 'agent-a',
        projects: [{ id: 'project-live' }],
        storage
      })
    ).toBe('project-live')
  })

  it('prefers remembered project, then agent default project, then first project', () => {
    const storage = memoryStorage()
    const projects = [{ id: 'project-a' }, { id: 'project-b' }, { id: 'project-c' }]

    rememberLastProjectForAgent('agent-a', 'project-c', storage)

    expect(
      resolveProjectIdForAgent({
        agentId: 'agent-a',
        projects,
        defaultProjectId: 'project-b',
        storage
      })
    ).toBe('project-c')

    expect(
      resolveProjectIdForAgent({
        agentId: 'agent-b',
        projects,
        defaultProjectId: 'project-b',
        storage
      })
    ).toBe('project-b')

    expect(
      resolveProjectIdForAgent({
        agentId: 'agent-c',
        projects,
        storage
      })
    ).toBe('project-a')
  })
})
