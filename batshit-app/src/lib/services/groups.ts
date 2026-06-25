import type { GroupChatGroupRow } from '$lib/types/database'

export class GroupService {
  async loadGroups(): Promise<GroupChatGroupRow[]> {
    const response = await fetch('/api/groups', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })

    if (!response.ok) {
      throw new Error('Failed to load groups')
    }

    const data = await response.json()
    return (data?.groups as GroupChatGroupRow[]) ?? []
  }

  async createGroup(payload: Partial<GroupChatGroupRow>): Promise<GroupChatGroupRow> {
    const response = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error?.error || 'Failed to create group')
    }

    return response.json()
  }

  async updateGroup(id: string, updates: Partial<GroupChatGroupRow>): Promise<void> {
    const response = await fetch(`/api/groups/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error?.error || 'Failed to update group')
    }
  }

  async deleteGroup(id: string): Promise<{ clearedSessionIds: string[] }> {
    const response = await fetch(`/api/groups/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error?.error || 'Failed to delete group')
    }

    const payload = await response.json().catch(() => null)
    return {
      clearedSessionIds: Array.isArray(payload?.clearedSessionIds)
        ? payload.clearedSessionIds.filter((entry: unknown): entry is string => typeof entry === 'string')
        : []
    }
  }
}
