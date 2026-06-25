import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentStore } from './agentStore'
import { dmrModels } from './dmrModels'
import { MessageApiClient } from './messageApiClient'
import { ollamaModels } from './ollamaModels'
import { ProjectService } from './projects'
import { SessionApiClient } from './sessionApiClient'
import { UploadApiService } from './uploadApi'
import { UserStore } from './userStore'

function failFetch(body = 'server unavailable', status = 500) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status }))
  )
}

describe('client facade failure handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('throws agent and subagent load failures instead of returning empty lists', async () => {
    failFetch('agents offline')

    const store = new AgentStore()

    await expect(store.getAgents('user-1')).rejects.toThrow('agents offline')
    await expect(store.getSubagents('user-1')).rejects.toThrow('agents offline')
  })

  it('throws session and message list failures instead of returning empty lists', async () => {
    failFetch('redis unavailable')

    await expect(new SessionApiClient().getSessions('user-1')).rejects.toThrow(
      'redis unavailable'
    )
    await expect(new MessageApiClient().getMessages('session-1')).rejects.toThrow(
      'redis unavailable'
    )
  })

  it('throws project load failures with the server-provided message', async () => {
    failFetch(JSON.stringify({ error: 'Project index unavailable' }))

    await expect(new ProjectService().loadProjects('user-1')).rejects.toThrow(
      'Project index unavailable'
    )
  })

  it('throws project preference load failures instead of returning null defaults', async () => {
    failFetch(JSON.stringify({ error: 'Project preferences unavailable' }))

    await expect(new ProjectService().loadPreferences()).rejects.toThrow(
      'Project preferences unavailable'
    )
  })

  it('throws clip and folder load failures instead of fabricating empty state', async () => {
    failFetch('clip store unavailable')

    const store = new UserStore()

    await expect(store.getClips('user-1')).rejects.toThrow('clip store unavailable')
    await expect(store.getClip('clip-1')).rejects.toThrow('clip store unavailable')
    await expect(store.getFolders()).rejects.toThrow('clip store unavailable')
  })

  it('throws batch zip failures instead of returning an empty map', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    failFetch('zip store unavailable')

    await expect(new UploadApiService().getZips(['zip-1'])).rejects.toThrow(
      'zip store unavailable'
    )
  })

  it('throws Ollama model list failures instead of reporting zero models', async () => {
    failFetch('Ollama unavailable', 503)

    await expect(ollamaModels.getInstalledModels()).rejects.toThrow(
      'Failed to fetch models'
    )
  })

  it('throws Docker Model Runner model list failures instead of reporting zero models', async () => {
    failFetch('Docker Model Runner unavailable', 503)

    await expect(dmrModels.getInstalledModels()).rejects.toThrow(
      'Failed to fetch Docker Model Runner models'
    )
  })
})
