import { describe, expect, it } from 'vitest'

import { DEFAULT_PROJECT_ID } from '$lib/projects/defaultProject'
import {
  LAST_PROJECT_BY_AGENT_STORAGE_KEY,
  readLastProjectByAgent,
  rememberLastProjectForAgent,
  resolveAgentDefaultProjectId,
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

const SAVED = [{ id: 'project-a' }, { id: 'project-b' }, { id: 'project-c' }]
const WITH_DEFAULT = [{ id: DEFAULT_PROJECT_ID }, ...SAVED]

describe('projectAgentMemory', () => {
  it('stores each agent pick with the saved default it was made against', () => {
    const storage = memoryStorage()

    rememberLastProjectForAgent({ agentId: 'agent-a', projectId: 'project-c', projects: SAVED, defaultProjectId: 'project-b', storage })
    rememberLastProjectForAgent({ agentId: 'agent-b', projectId: 'project-a', projects: WITH_DEFAULT, defaultProjectId: null, storage })

    expect(readLastProjectByAgent(storage)).toEqual({
      'agent-a': { projectId: 'project-c', againstDefaultProjectId: 'project-b' },
      'agent-b': { projectId: 'project-a', againstDefaultProjectId: null }
    })
  })

  it('ignores corrupt storage and a pick of a project that is gone', () => {
    const corrupt = memoryStorage({ [LAST_PROJECT_BY_AGENT_STORAGE_KEY]: '{not json' })
    expect(readLastProjectByAgent(corrupt)).toEqual({})

    const storage = memoryStorage()
    rememberLastProjectForAgent({ agentId: 'agent-a', projectId: 'project-gone', projects: SAVED, defaultProjectId: 'project-b', storage })
    expect(resolveProjectIdForAgent({ agentId: 'agent-a', projects: SAVED, defaultProjectId: 'project-b', storage })).toBe('project-b')
  })

  // BL-2372: a pick written before the fix records no default, so no save could outrank it.
  it('does not read a pick stored before BL-2372 (a bare project id)', () => {
    const storage = memoryStorage({
      [LAST_PROJECT_BY_AGENT_STORAGE_KEY]: JSON.stringify({ 'agent-a': 'project-c' })
    })

    expect(readLastProjectByAgent(storage)).toEqual({})
    expect(resolveProjectIdForAgent({ agentId: 'agent-a', projects: WITH_DEFAULT, defaultProjectId: null, storage })).toBe(
      DEFAULT_PROJECT_ID
    )
  })

  it('prefers the pick while the saved default is the one it was made against', () => {
    const storage = memoryStorage()
    rememberLastProjectForAgent({ agentId: 'agent-a', projectId: 'project-c', projects: SAVED, defaultProjectId: 'project-b', storage })

    expect(resolveProjectIdForAgent({ agentId: 'agent-a', projects: SAVED, defaultProjectId: 'project-b', storage })).toBe('project-c')
    expect(resolveProjectIdForAgent({ agentId: 'agent-b', projects: SAVED, defaultProjectId: 'project-b', storage })).toBe('project-b')
  })

  // BL-2372: Josh's case. The sidebar showed batshit (a pick), then Agent Settings saved Default.
  it('a newer saved default outranks the pick, which is forgotten and never comes back', () => {
    const storage = memoryStorage()
    rememberLastProjectForAgent({ agentId: 'agent-a', projectId: 'project-c', projects: WITH_DEFAULT, defaultProjectId: 'project-b', storage })

    // The default is saved as Default: the pick no longer applies.
    expect(resolveProjectIdForAgent({ agentId: 'agent-a', projects: WITH_DEFAULT, defaultProjectId: null, storage })).toBe(
      DEFAULT_PROJECT_ID
    )
    expect(readLastProjectByAgent(storage)).toEqual({})

    // Saved back to project-b later: still the save, not the old pick.
    expect(resolveProjectIdForAgent({ agentId: 'agent-a', projects: WITH_DEFAULT, defaultProjectId: 'project-b', storage })).toBe(
      'project-b'
    )
  })

  // BL-2373: an agent on Default never gets the first saved project forced onto it.
  it('an agent on Default gets the Default Project, or nothing, never the first saved project', () => {
    expect(resolveAgentDefaultProjectId({ projects: WITH_DEFAULT, defaultProjectId: null })).toBe(DEFAULT_PROJECT_ID)
    expect(resolveAgentDefaultProjectId({ projects: WITH_DEFAULT, defaultProjectId: '  ' })).toBe(DEFAULT_PROJECT_ID)
    expect(resolveAgentDefaultProjectId({ projects: SAVED, defaultProjectId: null })).toBeNull()
    expect(resolveProjectIdForAgent({ agentId: 'agent-c', projects: SAVED, storage: memoryStorage() })).toBeNull()
  })

  it('a saved default that is gone selects nothing rather than another project', () => {
    expect(resolveAgentDefaultProjectId({ projects: WITH_DEFAULT, defaultProjectId: 'project-gone' })).toBeNull()
  })

  it('picking the project the agent would get anyway clears the memory', () => {
    const storage = memoryStorage()
    rememberLastProjectForAgent({ agentId: 'agent-a', projectId: 'project-c', projects: WITH_DEFAULT, defaultProjectId: null, storage })
    expect(readLastProjectByAgent(storage)).toHaveProperty('agent-a')

    rememberLastProjectForAgent({ agentId: 'agent-a', projectId: DEFAULT_PROJECT_ID, projects: WITH_DEFAULT, defaultProjectId: null, storage })
    expect(readLastProjectByAgent(storage)).toEqual({})
  })

  it('keeps working when browser storage refuses a write', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      }
    }
    expect(() =>
      rememberLastProjectForAgent({ agentId: 'agent-a', projectId: 'project-c', projects: SAVED, defaultProjectId: null, storage })
    ).not.toThrow()
  })
})
