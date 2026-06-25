import type { ChatSession } from '$lib/stores/session.svelte'
import { DatabaseService } from './databaseRedis.client'
import * as sessionStore from '$lib/stores/session.svelte'
import { logger } from '$lib/utils/logger'

export class SessionService {
  private db: DatabaseService
  
  constructor() {
    this.db = new DatabaseService()
  }
  
  // Generate timestamp-based session ID (like v1)
  generateSessionId(): string {
    const now = new Date()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const year = String(now.getFullYear()).slice(-2) // Last 2 digits of year
    const hours = now.getHours()
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')
    const ampm = hours >= 12 ? 'pm' : 'am'
    const displayHours = String(hours % 12 || 12).padStart(2, '0')
    
    // Format: 06-20-25-07_14-and-28s-am
    return `${month}-${day}-${year}-${displayHours}_${minutes}-and-${seconds}s-${ampm}`
  }
  
  // Generate default session name with timestamp
  generateSessionName(): string {
    const now = new Date()
    const options: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }
    return now.toLocaleString('en-US', options)
  }
  
  // Load sessions for current user
  async loadSessions(userId: string, includeArchived = false) {
    try {
      const sessions = await this.db.getSessions(userId, includeArchived)
      // Map ChatSessionRow to ChatSession, ensuring user_id is always defined
      const mappedSessions = sessions.map(session => ({
        ...session,
        user_id: session.user_id || userId // Use the passed userId if session.user_id is undefined
      }))
      sessionStore.setSessions(mappedSessions)

      const currentId = sessionStore.getCurrentSessionId()
      if (!currentId || !mappedSessions.some(session => session.id === currentId)) {
        let fallbackId: string | null = null
        if (typeof window !== 'undefined') {
          const storedId = localStorage.getItem('batshit:lastSessionId')
          if (storedId && mappedSessions.some(session => session.id === storedId)) {
            fallbackId = storedId
          }
        }

        if (!fallbackId && mappedSessions.length > 0) {
          const sortedSessions = [...mappedSessions].sort((a, b) =>
            new Date(b.last_modified_at).getTime() - new Date(a.last_modified_at).getTime()
          )
          fallbackId = sortedSessions[0].id
        }

        if (fallbackId) {
          sessionStore.setCurrentSessionId(fallbackId)
        } else if (currentId) {
          // Clear stale session selection (e.g. localStorage points to a deleted session)
          sessionStore.setCurrentSessionId(null)
        }
      }
      return sessions
    } catch (error) {
      console.error('Error loading sessions:', error)
      throw error
    }
  }
  
  // Create new session
  async createSession(userId: string, folderId?: string, agentId?: string | null) {
    const sessionId = this.generateSessionId()
    const sessionName = this.generateSessionName()
    const initialAgentId = typeof agentId === 'string' && agentId.trim().length > 0
      ? agentId.trim()
      : null

    const newSession: Partial<ChatSession> = {
      id: sessionId,
      user_id: userId,
      name: sessionName,
      folder_id: folderId, // Add folder_id to the new session
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      archived: false,
      locked: false,
      ...(initialAgentId
        ? {
            agent_id: initialAgentId,
            metadata: {
              agent_id: initialAgentId,
              last_agent_id: initialAgentId
            }
          }
        : {})
    }

    try {
      const created = await this.db.createSession(newSession)
      sessionStore.addSession(created as ChatSession)
      sessionStore.setCurrentSessionId(created.id)
      
      // Force a re-render by updating the session list
      const currentSessions = sessionStore.getSessions()
      logger.debug('Sessions after adding:', currentSessions)
      
      return created
    } catch (error) {
      console.error('Error creating session:', error)
      throw error
    }
  }
  
  // Update session name
  async updateSessionName(sessionId: string, name: string) {
    try {
      await this.db.updateSession(sessionId, { name })
      sessionStore.updateSession(sessionId, { name })
    } catch (error) {
      console.error('Error updating session name:', error)
      throw error
    }
  }
  
  // Update session ID (now properly migrates all data in Redis!)
  async updateSessionId(oldId: string, newId: string): Promise<boolean> {
    try {
      const currentSession = sessionStore.getSessions().find(s => s.id === oldId)
      if (!currentSession) return false

      // Locked sessions cannot be renamed because ID migration requires deletion of old ID
      if (currentSession.locked) {
        logger.debug('Cannot change session ID while session is locked')
        return false
      }

      // Check if the session has any messages
      const messages = await this.db.getMessages(oldId)
      const hasMessages = messages && messages.length > 0
      
      // If session has messages, don't allow ID change
      if (hasMessages) {
        logger.debug('Cannot change session ID after messages have been sent')
        return false
      }
      
      const existingResponse = await fetch(`/api/sessions/${encodeURIComponent(newId)}`)
      if (existingResponse.ok) {
        logger.debug('Session ID already exists:', newId)
        return false
      }
      if (existingResponse.status !== 404) {
        logger.warn('Unable to verify session ID availability:', {
          newId,
          status: existingResponse.status
        })
        return false
      }
      
      logger.debug('Migrating session ID from', oldId, 'to', newId)
      
      // Create new session with new ID
      const newSession = { ...currentSession, id: newId }
      await this.db.createSession(newSession)
      
      // Delete old session
      await this.db.deleteSession(oldId)
      
      // Update store
      sessionStore.deleteSession(oldId)
      sessionStore.addSession(newSession)
      
      // Update current session ID if needed
      if (sessionStore.getCurrentSessionId() === oldId) {
        sessionStore.setCurrentSessionId(newId)
      }
      
      logger.debug(`Successfully updated session ID from ${oldId} to ${newId}`)
      return true
    } catch (error) {
      console.error('Error updating session ID:', error)
      return false
    }
  }
  
  // Delete session
  async deleteSession(sessionId: string): Promise<boolean> {
    const currentSession = sessionStore.getSessions().find((session) => session.id === sessionId)
    if (currentSession?.locked) {
      throw new Error('Session is locked. Unlock it before deleting.')
    }

    try {
      // Check if we're deleting the current session
      const isCurrentSession = sessionStore.getCurrentSessionId() === sessionId
      
      // Delete from database first
      await this.db.deleteSession(sessionId)
      
      // Delete from store (this will also clear currentSessionId if needed)
      sessionStore.deleteSession(sessionId)
      
      if (isCurrentSession) {
        logger.debug('Deleted current session, currentSessionId cleared')
      }
      
      return true // Return success
    } catch (error) {
      if (error instanceof Error && /locked/i.test(error.message)) {
        throw new Error('Session is locked. Unlock it before deleting.')
      }
      console.error('Error deleting session:', error)
      throw error
    }
  }

  async updateSessionLock(sessionId: string, locked: boolean) {
    try {
      await this.db.updateSession(sessionId, { locked })
      sessionStore.updateSession(sessionId, { locked })
    } catch (error) {
      console.error('Error updating session lock:', error)
      throw error
    }
  }

  async sessionHasMessages(sessionId: string): Promise<boolean> {
    try {
      const messages = await this.db.getMessages(sessionId, 1)
      return Array.isArray(messages) && messages.length > 0
    } catch (error) {
      console.error('Error checking whether session has messages:', error)
      // Fail safe: if we cannot verify, treat as locked for ID edits
      return true
    }
  }
  
  // Archive session
  async archiveSession(sessionId: string): Promise<boolean> {
    try {
      await this.db.archiveSession(sessionId)
      sessionStore.deleteSession(sessionId) // Remove from active sessions list
      return true
    } catch (error) {
      console.error('Error archiving session:', error)
      throw error
    }
  }
  
  // Unarchive session
  async unarchiveSession(sessionId: string): Promise<boolean> {
    try {
      await this.db.unarchiveSession(sessionId)
      // Reload sessions to get the updated list
      const userId = sessionStore.getSessions()[0]?.user_id
      if (userId) {
        await this.loadSessions(userId, false) // Load active sessions
      }
      return true
    } catch (error) {
      console.error('Error unarchiving session:', error)
      throw error
    }
  }
  
  // Select session
  selectSession(sessionId: string) {
    sessionStore.setCurrentSessionId(sessionId)
  }

  async deleteSessions(sessionIds: string[]): Promise<boolean> {
    for (const id of sessionIds) {
      await this.deleteSession(id)
    }
    return true
  }
}
