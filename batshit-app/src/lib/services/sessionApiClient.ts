// Session API client operations for Redis-backed routes.
// Handles all session-related CRUD operations through the SvelteKit API.

import { RedisStoreBase } from './redisCore'
import type { ChatSessionRow } from '$lib/types/database'

export class SessionApiClient extends RedisStoreBase {
  // Sessions
  async getSessions(userId: string, includeArchived = false) {
    const params = includeArchived ? '?includeArchived=true' : ''
    const sessions = await this.apiCall(`/sessions${params}`)
    return sessions as ChatSessionRow[]
  }

  async createSession(session: Partial<ChatSessionRow>) {
    const response = await this.apiCall('/sessions', {
      method: 'POST',
      body: JSON.stringify(session)
    })

    return response as ChatSessionRow
  }

  async updateSession(id: string, updates: Partial<ChatSessionRow>) {
    await this.apiCall(`/sessions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
  }

  async deleteSession(id: string) {
    await this.apiCall(`/sessions/${id}`, {
      method: 'DELETE'
    })
  }

  async archiveSession(id: string) {
    await this.updateSession(id, {
      archived: true,
      archived_at: new Date().toISOString()
    })
  }

  async unarchiveSession(id: string) {
    await this.updateSession(id, {
      archived: false,
      archived_at: null
    })
  }

  async touchSession(sessionId: string): Promise<void> {
    try {
      await this.updateSession(sessionId, {
        last_modified_at: new Date().toISOString()
      })
    } catch (error) {
      console.error('Failed to touch session:', error)
    }
  }

}

export const sessionApiClient = new SessionApiClient()
