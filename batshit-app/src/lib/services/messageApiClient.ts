// Message API client operations for Redis-backed routes.
// Handles message CRUD and compilation through the SvelteKit API.

import { RedisStoreBase } from './redisCore'
import type { ChatMemoryRow } from '$lib/types/database'
import type { Message } from '$lib/stores/messages.svelte'

export class MessageApiClient extends RedisStoreBase {
  // Messages
  async getMessages(sessionId: string, limit = 100) {
    const messages = await this.apiCall(`/messages/${sessionId}?limit=${limit}`)
    return messages as ChatMemoryRow[]
  }

  async getSessionMessages(sessionId: string): Promise<Message[]> {
    try {
      const messages = (await this.apiCall(`/messages/${sessionId}?limit=1000`)) as ChatMemoryRow[]

      const mapped = messages.map(msg => {
        const m = msg as any
        const metadata =
          m.metadata && typeof m.metadata === 'object'
            ? m.metadata
            : undefined
        const status: Message['status'] =
          m.status === 'error' || metadata?.error_message
            ? 'error'
            : m.status === 'in_progress'
              ? 'in_progress'
              : 'complete'
        return {
          id: m.id,
          session_id: m.session_id,
          user_id: m.user_id || '',
          agent_id: m.agent_id || undefined,
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content || '',
          timestamp: m.created_at,
          created_at: m.created_at,
          metadata,
          tokens: m.tokens || undefined,
          status,
          model: m.model || undefined,
          provider: m.provider || undefined,
          clips: m.clips || undefined,
          intermediateSteps: m.intermediateSteps || undefined
        }
      })

      // Sort by creation time
      mapped.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

      return mapped
    } catch (error) {
      console.error('Failed to get session messages:', error)
      throw error
    }
  }

  async saveMessage(message: Message | Partial<ChatMemoryRow>, agent?: any) {
    const metadata =
      (message as any).metadata && typeof (message as any).metadata === 'object'
        ? (message as any).metadata
        : {}
    const providerMessageSource =
      metadata.providerMessageSource && typeof metadata.providerMessageSource === 'object'
        ? metadata.providerMessageSource
        : {}
    const firstString = (...values: unknown[]) => {
      for (const value of values) {
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (trimmed.length > 0) return trimmed
      }
      return undefined
    }
    const messageData = {
      ...message,
      model: firstString(
        (message as any).model,
        (message as any).model_id,
        providerMessageSource.modelId,
        metadata.primary_model_effective_id,
        metadata.primary_model_model_id,
        metadata.primary_model_name,
        agent?.primary_model_name
      ),
      provider: firstString(
        (message as any).provider,
        providerMessageSource.providerId,
        metadata.primary_model_provider_id,
        metadata.primary_model_provider,
        agent?.primary_model_provider
      )
    }

    const response = await this.apiCall('/messages', {
      method: 'POST',
      body: JSON.stringify(messageData)
    })

    return response
  }

  async updateMessage(messageId: string, sessionId: string, updates: Partial<ChatMemoryRow>, userId: string) {
    await this.apiCall(`/messages/${sessionId}/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...updates, session_id: sessionId, user_id: userId })
    })
  }

  async deleteMessage(messageId: string, sessionId: string, userId: string) {
    await this.apiCall(`/messages/${sessionId}/${messageId}`, {
      method: 'DELETE',
      body: JSON.stringify({ session_id: sessionId, user_id: userId })
    })
  }

}

export const messageApiClient = new MessageApiClient()
