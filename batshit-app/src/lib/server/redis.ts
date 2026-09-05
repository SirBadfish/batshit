// Direct Redis service for SvelteKit server-side operations
// Replaces batshit-server proxy with direct Redis 8 JSON support

import { logger } from '$lib/utils/logger'
import { createClient, type RedisClientType } from 'redis'
import type { 
  ChatSessionRow, 
  ChatMemoryRow, 
  AgentRow, 
  GroupChatGroupRow,
  UserSettingsRow, 
  ProjectRow,
  ProjectPreferences,
  SubagentRow,
  ChatFolderRow 
} from '$lib/types/database'
import type { VoiceSettings, VoiceProfileRecord } from '$lib/types/voice'
import type { GoonsSettings } from '$lib/types/goons'
import type { Message } from '$lib/stores/messages.svelte'
import {
  normalizeGroupMaxAgents,
  normalizeGroupMaxFollowupsTotal
} from '$lib/types/groupChat'
import {
  canonicalizePrimaryAgentRecord,
  hasLegacyPrimaryAgentFields,
  normalizePrimaryAgentType,
  shouldShowReasoningByDefaultForPrimaryAgent
} from '$lib/utils/primaryAgentType'
import {
  collectTrustedClipIdsFromMetadata,
  neutralizeAllZipReferenceSyntax,
  neutralizeUntrustedClipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import {
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'

async function resolveRuntimeRedisUrl(): Promise<string> {
  return resolveRedisConnectionUrl({
    REDIS_URL: await getRuntimeEnv('REDIS_URL'),
    REDIS_HOST: await getRuntimeEnv('REDIS_HOST'),
    REDIS_PORT: await getRuntimeEnv('REDIS_PORT'),
    REDIS_DB: await getRuntimeEnv('REDIS_DB')
  })
}

// Every port a real Batshit Redis can listen on across install types (developer
// default, Mac app, and isolated smoke/first-run test instances). The memory-search
// test escape below must never match them.
const BATSHIT_KNOWN_RUNTIME_REDIS_PORTS = new Set(['6379', '5639', '6380', '5649'])

function isDesignatedMemorySearchTestUrl(redisUrl: string): boolean {
  if (process.env.VITEST_MEMORY_SEARCH !== 'true') return false
  const designated = process.env.MEMORY_TEST_REDIS_URL?.trim()
  if (!designated || redisUrl !== designated) return false
  try {
    const port = new URL(redisUrl).port || '6379'
    return !BATSHIT_KNOWN_RUNTIME_REDIS_PORTS.has(port)
  } catch {
    return false
  }
}

function isProjectPreferences(value: unknown): value is ProjectPreferences {
  if (!value || typeof value !== 'object') return false
  const prefs = value as Partial<ProjectPreferences>
  return (
    typeof prefs.user_id === 'string' &&
    typeof prefs.created_at === 'string' &&
    typeof prefs.updated_at === 'string'
  )
}

export class RedisService {
  private static instances = new Set<RedisService>()
  private client: RedisClientType | null = null
  private connecting = false

  private parseTimestampMs(value?: string | null): number {
    if (!value) return 0
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : 0
  }

  private newestTimestamp(...values: Array<string | null | undefined>): string | undefined {
    let newest: string | undefined
    let newestMs = 0

    for (const value of values) {
      const time = this.parseTimestampMs(value)
      if (time > newestMs) {
        newest = value || undefined
        newestMs = time
      }
    }

    return newest
  }

  private sortFoldersForDisplay(folders: ChatFolderRow[]): ChatFolderRow[] {
    return folders.sort((a, b) => {
      if (a.is_default !== b.is_default) {
        return a.is_default ? -1 : 1
      }

      const activityDelta =
        Math.max(this.parseTimestampMs(b.last_used_at), this.parseTimestampMs(b.created_at)) -
        Math.max(this.parseTimestampMs(a.last_used_at), this.parseTimestampMs(a.created_at))
      if (activityDelta !== 0) return activityDelta

      const createdDelta = this.parseTimestampMs(b.created_at) - this.parseTimestampMs(a.created_at)
      if (createdDelta !== 0) return createdDelta

      const sortDelta = a.sort_order - b.sort_order
      if (sortDelta !== 0) return sortDelta

      return a.name.localeCompare(b.name)
    })
  }

  private async touchFolderLastUsed(
    client: any,
    userId: string | undefined,
    folderId: string | undefined,
    at: string = new Date().toISOString()
  ): Promise<void> {
    if (!userId || !folderId) return
    const folder = await client.json.get(`folder:${userId}:${folderId}`)
    if (!folder) return

    const folderData = folder as unknown as ChatFolderRow
    folderData.last_used_at = this.newestTimestamp(folderData.last_used_at, at) ?? at
    await client.json.set(`folder:${userId}:${folderId}`, '$', folderData as any)
  }

  constructor() {
    // Initialize connection on first use, then close it from the app runtime
    // shutdown hook so packaged Mac stops do not need SIGKILL escalation.
    RedisService.instances.add(this)
  }

  static async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(RedisService.instances, (service) =>
        service.disconnect().catch((error) => {
          console.error('[Redis] Failed to disconnect Redis client during shutdown:', error)
        })
      )
    )
  }

  // Get or create Redis connection
  private async getClient(): Promise<RedisClientType> {
    if (this.client && this.client.isOpen) {
      return this.client
    }

    if (this.connecting) {
      // Wait for existing connection attempt
      while (this.connecting) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      if (this.client && this.client.isOpen) {
        return this.client
      }
    }

    this.connecting = true
    try {
      let redisUrl = await resolveRuntimeRedisUrl()

      // Test-safety: never allow Vitest to hit DB0. If no DB is specified,
      // or it points at /0, force it to DB15 so we don't wipe dev/prod data.
      //
      // Single narrow exception (SA-104, testing-architecture.md §3): the memory-search
      // test lane runs against a DEDICATED DISPOSABLE Redis whose db 0 it owns, because
      // FT.CREATE only works on db 0. The escape applies only when the lane env is on,
      // the URL is exactly the harness-designated MEMORY_TEST_REDIS_URL, and the port is
      // not one of Batshit's known runtime ports — real instances can never qualify.
      if (process.env.VITEST === 'true' && !isDesignatedMemorySearchTestUrl(redisUrl)) {
        const hasDb = /\/\d+$/.test(redisUrl)
        if (!hasDb) {
          redisUrl = `${redisUrl}/15`
        } else if (redisUrl.endsWith('/0')) {
          redisUrl = redisUrl.replace(/\/0$/, '/15')
        }

        // Keep the env mock in sync for any code that reads $env directly.
        process.env.REDIS_URL = redisUrl
        try {
          const envModule = await import('$env/dynamic/private')
          if (envModule?.env) {
            envModule.env.REDIS_URL = redisUrl
          }
        } catch {
          // ignore if env module not available yet
        }
      }

      const urlObj = new URL(redisUrl)
      const dbFromUrl = urlObj.pathname && urlObj.pathname !== '/' ? Number(urlObj.pathname.slice(1)) : undefined
      const database = Number.isInteger(dbFromUrl) ? dbFromUrl : undefined

      this.client = createClient({
        url: redisUrl,
        database,
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 1000)
        }
      })

      this.client.on('error', (err) => {
        console.error('Redis client error:', err)
      })

      this.client.on('connect', () => {
        logger.debug('Redis client connected')
      })

      this.client.on('ready', () => {
        logger.debug('Redis client ready')
      })

      await this.client.connect()
      return this.client
    } finally {
      this.connecting = false
    }
  }

  // Helper to safely execute Redis commands
  async execute<T>(operation: (client: RedisClientType) => Promise<T>): Promise<T> {
    const client = await this.getClient()
    if (!client.isOpen) {
      console.error('[Redis.execute] Client is not connected!')
    }
    return operation(client)
  }

  // Helper to safely parse JSON - intelligently handles both JSON and plain strings
  // Note: This is now only used for mixed string/object keys like system prompts
  private safeJsonParse(data: any): any {
    if (!data) return null
    if (typeof data === 'string') {
      // Check if it looks like JSON (starts with { or [ after trimming)
      const trimmed = data.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
        try {
          return JSON.parse(data)
        } catch (error) {
          // If it fails to parse but looks like JSON, there's a real error
          console.error('Failed to parse JSON string:', error)
          // Return the string as-is for system prompts and other plain text
          return data
        }
      }
      // Doesn't look like JSON, return as plain string (e.g., system prompts)
      return data
    }
    // If it's already an object, return as-is
    return data
  }

  // ===== SESSIONS =====

  async getSessions(userId: string, includeArchived = false): Promise<ChatSessionRow[]> {
    return this.execute(async (client) => {
      // Get all session IDs for user
      const sessionIds = await client.sMembers(`user:${userId}:sessions`)
      
      if (sessionIds.length === 0) {
        return []
      }
      
      // Get all session data using RedisJSON
      const sessions: ChatSessionRow[] = []
      for (const sessionId of sessionIds) {
        try {
          const sessionData = await client.json.get(`session:${sessionId}`)
          if (sessionData) {
            const session = sessionData as unknown as ChatSessionRow
            if (!session.archived || includeArchived) {
              sessions.push(session)
            }
          }
        } catch (error) {
          logger.warn(`Failed to load session ${sessionId}:`, error)
        }
      }
      
      // Sort by last_modified_at descending
      sessions.sort((a, b) => {
        const dateA = new Date(a.last_modified_at || a.created_at).getTime()
        const dateB = new Date(b.last_modified_at || b.created_at).getTime()
        return dateB - dateA
      })
      
      return sessions
    })
  }

  async getSession(sessionId: string): Promise<ChatSessionRow | null> {
    return this.execute(async (client) => {
      try {
        const sessionData = await client.json.get(`session:${sessionId}`)
        if (!sessionData) return null
        
        return sessionData as unknown as ChatSessionRow
      } catch (error) {
        console.error('[getSession] Error:', error)
        return null
      }
    })
  }

  async createSession(session: Partial<ChatSessionRow>): Promise<ChatSessionRow> {
    return this.execute(async (client) => {
      // If no folder_id provided, get or create default folder
      let folderId = session.folder_id
      
      if (!folderId && session.user_id) {
        // Check for default folder
        const defaultFolderId = await client.get(`user:${session.user_id}:default_folder`)
        
        if (defaultFolderId) {
          folderId = defaultFolderId
        } else {
          // Create default folder if it doesn't exist
          const newDefaultFolderId = crypto.randomUUID()
          const now = new Date().toISOString()
          const defaultFolder = {
            id: newDefaultFolderId,
            user_id: session.user_id,
            name: 'My Chats',
            is_default: true,
            is_expanded: true,
            sort_order: 0,
            last_used_at: now,
            created_at: now
          }
          
          await client.json.set(`folder:${session.user_id}:${newDefaultFolderId}`, '$', defaultFolder)
          await client.sAdd(`user:${session.user_id}:folders`, newDefaultFolderId)
          await client.set(`user:${session.user_id}:default_folder`, newDefaultFolderId)
          
          folderId = newDefaultFolderId
        }
      }
      
      const sessionData: ChatSessionRow = {
        ...session,
        id: session.id!,
        folder_id: folderId,
        created_at: session.created_at || new Date().toISOString(),
        last_modified_at: session.last_modified_at || new Date().toISOString(),
        archived: false,
        locked: Boolean(session.locked)
      }
      
      // Store session using RedisJSON
      await client.json.set(`session:${sessionData.id}`, '$', sessionData as any)
      
      // Add to user's session list
      if (sessionData.user_id) {
        await client.sAdd(`user:${sessionData.user_id}:sessions`, sessionData.id)
        
        // Add session to folder's session set
        if (folderId) {
          await client.sAdd(`folder:${sessionData.user_id}:${folderId}:sessions`, sessionData.id)
          await this.touchFolderLastUsed(
            client,
            sessionData.user_id,
            folderId,
            sessionData.last_modified_at
          )
        }
      }
      
      // Create empty message list for this session
      await client.del(`messages:${sessionData.id}`)
      
      return sessionData
    })
  }

  async updateSession(id: string, updates: Partial<ChatSessionRow>): Promise<void> {
    return this.execute(async (client) => {
      // Get existing session
      const existing = await client.json.get(`session:${id}`)
      if (!existing) throw new Error('Session not found')
      
      // Update with new data
      const now = new Date().toISOString()
      const updated = {
        ...(existing as any),
        ...updates,
        last_modified_at: now
      }
      
      await client.json.set(`session:${id}`, '$', updated)
      await this.touchFolderLastUsed(client, updated.user_id, updated.folder_id, now)
    })
  }

  async deleteSession(id: string): Promise<void> {
    return this.execute(async (client) => {
      try {
        logger.debug(`[deleteSession] Starting deletion for session ${id}`)
        
        // Get session to find user_id
        const session = await client.json.get(`session:${id}`)
        logger.debug(`[deleteSession] Found session:`, session ? 'YES' : 'NO')

        const sessionObj = session as any
        if (sessionObj?.locked) {
          throw new Error('Session is locked and cannot be deleted until unlocked')
        }
        
        // Delete all messages in this session and collect zip IDs
        const messageIds = await client.lRange(`messages:${id}`, 0, -1)
        logger.debug(`[deleteSession] Found ${messageIds.length} messages to delete`)
        const zipIdsToDelete = new Set<string>()
        
        // FIRST: Get all zips associated with this session from the session's zip set
        try {
          const sessionZips = await client.sMembers(`session:${id}:zips`)
          if (sessionZips && sessionZips.length > 0) {
            logger.debug(`[deleteSession] Found ${sessionZips.length} zips in session zip set`)
            sessionZips.forEach(zipId => zipIdsToDelete.add(zipId))
          }
        } catch (error) {
          console.error(`[deleteSession] Error getting session zips:`, error)
        }
        
        for (const msgId of messageIds) {
          try {
            // Get message to extract zip IDs before deleting
            const messageKey = `message:${id}:${msgId}`
            const message = await client.json.get(messageKey)
            if (message) {
              // Extract zip IDs from zipMetadata
              const messageObj = message as any
              if (messageObj.zipMetadata && Array.isArray(messageObj.zipMetadata)) {
                for (const zipMeta of messageObj.zipMetadata) {
                  if (zipMeta.zipId) {
                    zipIdsToDelete.add(zipMeta.zipId)
                  }
                }
              }
              
              // Check for new format zips: {{batshit-zip:id}} or {{batshit-zip:id:::description}}
              const newZipPattern = /\{\{batshit-zip:([^:}\s]+)(?::::[^}]+)?\}\}/g
              let match
              while ((match = newZipPattern.exec(messageObj.content || '')) !== null) {
                zipIdsToDelete.add(match[1])
              }
              
              // Also check for old format (backward compatibility during transition)
              const oldZipPattern = /\{\{batshit\|id:([^|]+)\|/g
              while ((match = oldZipPattern.exec(messageObj.content || '')) !== null) {
                zipIdsToDelete.add(match[1])
              }
            }
            
            await client.del(messageKey)
          } catch (msgError) {
            console.error(`[deleteSession] Error processing message ${msgId}:`, msgError)
            // Continue with other messages
          }
        }
        
        // Delete the session's zip set
        try {
          await client.del(`session:${id}:zips`)
        } catch (error) {
          console.error(`[deleteSession] Error deleting session zip set:`, error)
        }
      
        // Delete all collected zips
        if (zipIdsToDelete.size > 0) {
          logger.debug(`[deleteSession] Deleting ${zipIdsToDelete.size} zips for session ${id}`)
          for (const zipId of zipIdsToDelete) {
            try {
              await client.del(`zip:${zipId}`)
            } catch (zipError) {
              console.error(`[deleteSession] Error deleting zip ${zipId}:`, zipError)
            }
          }
        }
        
        // Delete pins for this session
        try {
          await client.del(`pins:${id}`)
        } catch (pinError) {
          console.error(`[deleteSession] Error deleting pins:`, pinError)
        }
        
        // Delete clip-related session data
        try {
          await client.del(`session:${id}:clips`)
          await client.del(`session:${id}:clip_state`)
          await client.del(`session:${id}:active_clips`)
        } catch (clipError) {
          console.error(`[deleteSession] Error deleting clip data:`, clipError)
        }

        // Delete the session's episode ledger + recall/linger state (SA-104, DL-104-13)
        try {
          const episodeKeys = await client.keys(`episode:${id}:*`)
          if (episodeKeys.length > 0) {
            await client.del(episodeKeys as [string, ...string[]])
          }
          await client.del(`session:${id}:episodes`)
          await client.del(`memlinger:${id}`)
        } catch (episodeError) {
          console.error(`[deleteSession] Error deleting episode ledger:`, episodeError)
        }
        
        // Delete all session_clip associations
        try {
          // Use KEYS command for pattern matching (Redis 8 compatible)
          // Note: KEYS is blocking but safe for small datasets
          const sessionClipKeys = await client.keys(`session_clip:${id}:*`)
          
          if (sessionClipKeys && sessionClipKeys.length > 0) {
            await client.del(sessionClipKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${sessionClipKeys.length} session_clip associations`)
          }
        } catch (scanError) {
          console.error(`[deleteSession] Error scanning/deleting session_clip keys:`, scanError)
        }
        
        // Delete any subagent sessions associated with this session
        try {
          // Use KEYS command for pattern matching (Redis 8 compatible)
          // Note: KEYS is blocking but safe for small datasets
          // Pattern matches: subagent_sessions:{sessionId}:subagent:{subagentName}
          const subagentKeys = await client.keys(`subagent_sessions:${id}:subagent:*`)

          if (subagentKeys && subagentKeys.length > 0) {
            await client.del(subagentKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${subagentKeys.length} subagent sessions`)
          }
        } catch (subagentError) {
          console.error(`[deleteSession] Error scanning/deleting subagent keys:`, subagentError)
        }

        // SA-111 P2: the Batshit-issued n8n Workflow Subagent thread ids
        // (`subagent_thread:{sessionId}:{slug}`, DL-111-06) and the in-flight run locks
        // (`subagent_lock:{sessionId}:{slug}`, DL-111-05). Both carry a TTL, but the
        // Session Key Cleanup rule is enumerate-don't-assume: a key that expires "soon"
        // still outlives its session until it does.
        try {
          const threadIdKeys = await client.keys(`subagent_thread:${id}:*`)
          if (threadIdKeys && threadIdKeys.length > 0) {
            await client.del(threadIdKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${threadIdKeys.length} subagent thread ids`)
          }

          const subagentLockKeys = await client.keys(`subagent_lock:${id}:*`)
          if (subagentLockKeys && subagentLockKeys.length > 0) {
            await client.del(subagentLockKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${subagentLockKeys.length} subagent run locks`)
          }
        } catch (threadError) {
          console.error(`[deleteSession] Error deleting subagent thread/lock keys:`, threadError)
        }

        // SA-111 AMD-111-02: scoped per-message n8n callback tokens. TTL-bounded (~30 min)
        // and deliberately NOT part of backup — they are short-lived credentials, not data —
        // but they are session-scoped state and belong in this sweep.
        try {
          const callbackKeys = await client.keys(`n8n:sse-callback:${id}:*`)
          if (callbackKeys && callbackKeys.length > 0) {
            await client.del(callbackKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${callbackKeys.length} n8n callback tokens`)
          }
        } catch (callbackError) {
          console.error(`[deleteSession] Error deleting n8n callback tokens:`, callbackError)
        }
        
        // Note: We don't delete upload:images:* keys because they might be shared across sessions
        // The session-specific upload references are handled as zips with pattern: {sessionId}-upload-*
        // These are already deleted above when we delete all zips from messages
        
        // Delete message list
        try {
          await client.del(`messages:${id}`)
        } catch (msgListError) {
          console.error(`[deleteSession] Error deleting message list:`, msgListError)
        }

	        // Delete session-specific message cache (used by send-routed for Batshit agents)
	        try {
	          await client.del(`session:${id}:messages`)
	          logger.debug(`[deleteSession] Deleted session:${id}:messages cache`)
	        } catch (msgCacheError) {
	          console.error(`[deleteSession] Error deleting message cache:`, msgCacheError)
	        }

	        // Delete execution viewer snapshots for this session
	        try {
	          await client.del(`session:${id}:execution_log`)
	          logger.debug(`[deleteSession] Deleted session:${id}:execution_log`)
	        } catch (executionLogError) {
	          console.error(`[deleteSession] Error deleting execution log:`, executionLogError)
	        }

	        // Delete session usage tracking
	        try {
	          await client.del(`session:${id}:usage`)
	          logger.debug(`[deleteSession] Deleted session:${id}:usage`)
	        } catch (usageError) {
          console.error(`[deleteSession] Error deleting session usage:`, usageError)
        }

        // Delete unzipped items tracking
        try {
          // Get all unzipped zip IDs for this session
          const unzippedKey = `unzipped:${id}`
          const unzippedIds = await client.sMembers(unzippedKey)

          if (unzippedIds && unzippedIds.length > 0) {
            logger.debug(`[deleteSession] Found ${unzippedIds.length} unzipped items to delete`)

            // Delete each unzipped item metadata
            for (const zipId of unzippedIds) {
              try {
                await client.del(`unzipped_item:${id}:${zipId}`)
              } catch (itemError) {
                console.error(`[deleteSession] Error deleting unzipped_item ${zipId}:`, itemError)
              }
            }
          }

          // Delete the unzipped set itself
          await client.del(unzippedKey)
          logger.debug(`[deleteSession] Deleted unzipped tracking for session`)
        } catch (unzipError) {
          console.error(`[deleteSession] Error deleting unzipped data:`, unzipError)
        }

        // Delete rezipped markers
        try {
          const rezippedKey = `rezipped:${id}`
          const rezippedIds = await client.sMembers(rezippedKey)
          if (rezippedIds && rezippedIds.length > 0) {
            for (const zipId of rezippedIds) {
              try {
                await client.del(`rezipped_item:${id}:${zipId}`)
              } catch (itemError) {
                console.error(`[deleteSession] Error deleting rezipped_item ${zipId}:`, itemError)
              }
            }
          }
          await client.del(rezippedKey)
          logger.debug(`[deleteSession] Deleted rezipped tracking for session`)
        } catch (rezipError) {
          console.error(`[deleteSession] Error deleting rezipped data:`, rezipError)
        }

        // Delete message counter for this session (Story 6.9b)
        try {
          await client.del(`message_counter:${id}`)
          logger.debug(`[deleteSession] Deleted message counter for session`)
        } catch (counterError) {
          console.error(`[deleteSession] Error deleting message counter:`, counterError)
        }

        // Delete session
        try {
          await client.del(`session:${id}`)
        } catch (sessionDelError) {
          console.error(`[deleteSession] Error deleting session:`, sessionDelError)
        }
        
        // Remove from user's session list
        if (sessionObj?.user_id) {
          try {
            await client.sRem(`user:${sessionObj.user_id}:sessions`, id)
          } catch (userSessionError) {
            console.error(`[deleteSession] Error removing from user session list:`, userSessionError)
          }
          
          // Remove from folder's session list
          if (sessionObj.folder_id) {
            try {
              await client.sRem(`folder:${sessionObj.user_id}:${sessionObj.folder_id}:sessions`, id)
            } catch (folderSessionError) {
              console.error(`[deleteSession] Error removing from folder session list:`, folderSessionError)
            }
          }
        }
        
        logger.debug(`[deleteSession] Successfully deleted session ${id} and all related data`)
        return // Return success - the main deletion worked even if some cleanup failed
      } catch (error) {
        console.error(`[deleteSession] Critical error deleting session ${id}:`, error)
        throw error
      }
    })
  }

  async archiveSession(id: string): Promise<void> {
    await this.updateSession(id, {
      archived: true,
      archived_at: new Date().toISOString()
    })
  }

  async unarchiveSession(id: string): Promise<void> {
    await this.updateSession(id, {
      archived: false,
      archived_at: null
    })
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, {
      last_modified_at: new Date().toISOString()
    })
  }

  // ===== MESSAGES =====

  async getMessages(sessionId: string, limit = 100): Promise<ChatMemoryRow[]> {
    return this.execute(async (client) => {
      // Get message IDs
      const messageIds = await client.lRange(`messages:${sessionId}`, 0, limit - 1)
      
      if (messageIds.length === 0) {
        return []
      }
      
      // Get all message data using RedisJSON for native JSON retrieval
      const messages: ChatMemoryRow[] = []
      for (const msgId of messageIds) {
        try {
          const key = `message:${sessionId}:${msgId}`
          // Pure RedisJSON - no parsing needed!
          const messageData = await client.json.get(key)
          if (messageData) {
            messages.push(messageData as unknown as ChatMemoryRow)
          }
        } catch (error) {
          logger.warn(`Failed to load message ${msgId}:`, error)
        }
      }
      
      return messages
    })
  }

  async getSessionMessages(sessionId: string): Promise<Message[]> {
    const messages = await this.getMessages(sessionId, 1000)
    
    return messages.map(msg => {
      const metadata =
        msg.metadata && typeof msg.metadata === 'object'
          ? msg.metadata
          : undefined
      const status =
        msg.status === 'error' || metadata?.error_message
          ? 'error'
          : msg.status === 'in_progress'
            ? 'in_progress'
            : 'complete'

      return {
        id: msg.id,
        session_id: msg.session_id,
        user_id: msg.user_id || '',
        agent_id: msg.agent_id || undefined,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content || '',
        timestamp: msg.created_at,
        created_at: msg.created_at,
        metadata,
        model: (msg as any).model || (msg as any).model_id || undefined,
        provider: (msg as any).provider || undefined,
        zipMetadata: msg.zipMetadata || undefined,
        toolResults: msg.toolResults || undefined,
        intermediateSteps: msg.intermediateSteps || undefined,
        toolPlaceholders: msg.toolPlaceholders || undefined,
        toolPreface: (msg as any).toolPreface || undefined,
        status
      } as Message
    })
  }

  async saveMessage(message: Message | Partial<ChatMemoryRow>): Promise<void> {
    return this.execute(async (client) => {
      // SA-911: Clean up duplicate zip refs before persisting (placeholders no longer used but kept for safety)
      const dedupeZipRefs = (text: any) => {
        if (text === null || text === undefined) return ''
        const asString =
          typeof text === 'string'
            ? text
            : (() => {
                try {
                  const json = JSON.stringify(text)
                  return typeof json === 'string' ? json : String(text)
                } catch {
                  return String(text)
                }
              })()

        if (!asString) return asString
        // Remove any stray placeholders (legacy, shouldn't exist after SA-911)
        let cleaned = asString.replace(/\{\{TOOL_LOADING_PLACEHOLDER:[^}]+\}\}/g, '')

        const seen = new Set<string>()
        cleaned = cleaned.replace(/\{\{batshit-zip:[^}]+\}\}/g, (m) => {
          if (seen.has(m)) return ''
          seen.add(m)
          return m
        })

        return cleaned.replace(/\n{3,}/g, '\n\n').trim()
      }

      const collectTrustedClipIds = async (sessionId: string, metadata: unknown) => {
        const ids = new Set(collectTrustedClipIdsFromMetadata(metadata))

        if (sessionId) {
          const state = await client.json.get(`session:${sessionId}:clip_state`).catch(() => null)
          const stateClips = Array.isArray((state as any)?.clips) ? (state as any).clips : []
          for (const entry of stateClips) {
            if (typeof entry?.clipId === 'string' && entry.clipId.trim()) {
              ids.add(entry.clipId.trim())
            }
          }

          const activeClipIds = await client.sMembers(`session:${sessionId}:active_clips`).catch(() => [])
          for (const clipId of activeClipIds) {
            if (clipId) ids.add(clipId)
          }

          const sessionClipIds = await client.sMembers(`session:${sessionId}:clips`).catch(() => [])
          for (const clipId of sessionClipIds) {
            if (clipId) ids.add(clipId)
          }
        }

        return Array.from(ids)
      }

      const sanitizePersistedContent = (
        text: any,
        role?: string,
        trustedClipIds?: string[]
      ) => {
        const cleaned = dedupeZipRefs(text)
        if (role !== 'user') return cleaned
        return neutralizeUntrustedClipReferenceSyntax(
          neutralizeAllZipReferenceSyntax(cleaned),
          { trustedClipIds }
        )
      }

      // Convert to ChatMemoryRow format
      const role = (message as any).role
      const sessionId = (message as any).session_id || ''
      const metadata = (message as any).metadata
      const trustedClipIds = await collectTrustedClipIds(sessionId, metadata)
      const messageData: ChatMemoryRow = {
        id: message.id || crypto.randomUUID(),
        session_id: sessionId,
        user_id: (message as any).user_id || '',
        agent_id: (message as any).agent_id,
        role,
        status: (message as any).status,
        content: sanitizePersistedContent((message as any).content || '', role, trustedClipIds),
        model_id: (message as any).model_id || (message as any).model,
        model: (message as any).model || (message as any).model_id,
        provider: (message as any).provider,
        zipMetadata: (message as any).zipMetadata,
        toolResults: (message as any).toolResults,
        intermediateSteps: (message as any).intermediateSteps,
        toolPlaceholders: (message as any).toolPlaceholders,
        toolPreface: (message as any).toolPreface,
        metadata: (message as any).metadata,
        created_at: new Date().toISOString()
      }

      // If the message already exists, merge metadata instead of overwriting it.
      // This prevents client-side "saveMessage" calls from clobbering server-enriched fields
      // (e.g. reasoning summaries, model ids, execution metadata).
      const messageKey = `message:${messageData.session_id}:${messageData.id}`
      const existing = await client.json.get(messageKey)
      if (existing && typeof existing === 'object') {
        const existingObj = existing as any

        messageData.created_at = existingObj.created_at || messageData.created_at

        const existingMetadata =
          existingObj.metadata && typeof existingObj.metadata === 'object'
            ? existingObj.metadata
            : {}
        const incomingMetadata =
          messageData.metadata && typeof messageData.metadata === 'object'
            ? messageData.metadata
            : {}
        messageData.metadata = {
          ...existingMetadata,
          ...incomingMetadata
        }

        if (!messageData.intermediateSteps && existingObj.intermediateSteps) {
          messageData.intermediateSteps = existingObj.intermediateSteps
        }
        if (!messageData.toolResults && existingObj.toolResults) {
          messageData.toolResults = existingObj.toolResults
        }
        if (!messageData.toolPlaceholders && existingObj.toolPlaceholders) {
          messageData.toolPlaceholders = existingObj.toolPlaceholders
        }
        if (!messageData.toolPreface && existingObj.toolPreface) {
          messageData.toolPreface = existingObj.toolPreface
        }
      }
      
      // Store message using RedisJSON for native JSON storage
      await client.json.set(messageKey, '$', messageData as any)
      
      // Add to session's message list (only if not already present)
      const existingMessages = await client.lRange(`messages:${messageData.session_id}`, 0, -1)
      const messageExists = existingMessages.includes(messageData.id)
      
      if (!messageExists) {
        await client.rPush(`messages:${messageData.session_id}`, messageData.id)
      }
      
      // Update session last activity
      if (messageData.session_id) {
        // Keep `session.agent_id` in sync with the most recent message so
        // server-side streaming helpers (SSE, zip detection, Mode 1 hydration)
        // can resolve the active agent without relying on client state.
        if (messageData.agent_id) {
          await this.updateSession(messageData.session_id, {
            agent_id: messageData.agent_id
          })
        } else {
          await this.touchSession(messageData.session_id)
        }
      }
    })
  }

  async updateMessage(messageId: string, sessionId: string, updates: Partial<ChatMemoryRow>, userId: string): Promise<void> {
    return this.execute(async (client) => {
      // Verify session belongs to user
      const session = await client.json.get(`session:${sessionId}`)
      if (!session) throw new Error('Session not found')
      const sessionObj = session as any
      if (sessionObj.user_id !== userId) throw new Error('Unauthorized: Session does not belong to user')
      
      // Get existing message
      const existing = await client.json.get(`message:${sessionId}:${messageId}`)
      if (!existing) throw new Error('Message not found')
      
      // Update the message
      const updated: Record<string, any> = {
        ...(existing as any),
        ...updates,
        updated_at: new Date().toISOString()
      }
      if (updated.role === 'user' && typeof updated.content === 'string') {
        const trustedClipIds = new Set(collectTrustedClipIdsFromMetadata(updated.metadata))

        const state = await client.json.get(`session:${sessionId}:clip_state`).catch(() => null)
        const stateClips = Array.isArray((state as any)?.clips) ? (state as any).clips : []
        for (const entry of stateClips) {
          if (typeof entry?.clipId === 'string' && entry.clipId.trim()) {
            trustedClipIds.add(entry.clipId.trim())
          }
        }

        const activeClipIds = await client.sMembers(`session:${sessionId}:active_clips`).catch(() => [])
        for (const clipId of activeClipIds) {
          if (clipId) trustedClipIds.add(clipId)
        }

        const sessionClipIds = await client.sMembers(`session:${sessionId}:clips`).catch(() => [])
        for (const clipId of sessionClipIds) {
          if (clipId) trustedClipIds.add(clipId)
        }

        updated.content = neutralizeUntrustedClipReferenceSyntax(
          neutralizeAllZipReferenceSyntax(updated.content),
          { trustedClipIds }
        )
      }
      
      await client.json.set(`message:${sessionId}:${messageId}`, '$', updated)
      
      // Touch session to update last activity
      await this.touchSession(sessionId)
    })
  }

  async deleteMessage(messageId: string, sessionId: string, userId: string): Promise<void> {
    return this.execute(async (client) => {
      // Verify session belongs to user
      const session = await client.json.get(`session:${sessionId}`)
      if (!session) throw new Error('Session not found')
      const sessionObj = session as any
      if (sessionObj.user_id !== userId) throw new Error('Unauthorized: Session does not belong to user')
      
      // Delete the message
      await client.del(`message:${sessionId}:${messageId}`)
      
      // Remove from session's message list
      await client.lRem(`messages:${sessionId}`, 0, messageId)

      // Clear any stale per-session message cache so refresh reloads the live list.
      await client.del(`session:${sessionId}:messages`)
      
      // Touch session to update last activity
      await this.touchSession(sessionId)
    })
  }

  // ===== AGENTS =====

  async getAgents(userId: string): Promise<AgentRow[]> {
    return this.execute(async (client) => {
      // Get all agent IDs for user
      const setKey = `user:${userId}:agents`
      const agentIds = await client.sMembers(setKey)

      if (agentIds.length === 0) {
        return []
      }
      
      // Get all agent data using RedisJSON
      const agents: AgentRow[] = []
      for (const agentId of agentIds) {
        try {
          const agentData = await client.json.get(`agent:${agentId}`)
          if (agentData) {
            const normalizedAgent = canonicalizePrimaryAgentRecord(
              agentData as Record<string, any>
            ) as AgentRow
            agents.push(resolveUploadUrlsForBrowserInPayload(normalizedAgent))

            if (hasLegacyPrimaryAgentFields(agentData as Record<string, any>)) {
              await client.json.set(
                `agent:${agentId}`,
                '$',
                normalizeUploadUrlsForStorageInPayload(normalizedAgent) as any
              )
            }
          }
        } catch (error) {
          logger.warn(`Failed to load agent ${agentId}:`, error)
        }
      }

      // Sort by created_at descending
      agents.sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime()
        const dateB = new Date(b.created_at || 0).getTime()
        return dateB - dateA
      })

      // Map database fields to frontend format
      const mappedAgents = agents.map(w => ({
        ...w,
        displayName: w.displayName || '',
        avatar_url: w.avatar || w.avatar_url || undefined,
        ai_permissions: {
          ...w.ai_permissions
        }
      }))

      return mappedAgents
    })
  }

  async createAgent(agent: Partial<AgentRow>): Promise<AgentRow> {
    return this.execute(async (client) => {
      // Add default granular settings for common tools
      const defaultGranularSettings = {
        // File reading - keep visible longer for reference
        buffer_size_read_file: 8,
        zip_threshold_read_file: 0,
        auto_zip_read_file: false,
        
        // File writing - moderate visibility
        buffer_size_write_file: 2,
        zip_threshold_write_file: 0,
        auto_zip_write_file: false,

        // File edit/diff operations
        buffer_size_edit_file: 2,
        zip_threshold_edit_file: 0,
        auto_zip_edit_file: false,

        // Command execution - compress quickly
        buffer_size_execute_command: 1,
        zip_threshold_execute_command: 0,
        auto_zip_execute_command: false,
        
        // Listing operations - compress immediately by default
        buffer_size_list_files: 1,
        zip_threshold_list_files: 0,
        auto_zip_list_files: true,
        
        // Fallback for all other tools
        buffer_size_all_other_tools: 1,
        zip_threshold_all_other_tools: 0,
        auto_zip_all_other_tools: true
      }

      const resolvedAgentType = normalizePrimaryAgentType(agent)

      const show_reasoning =
        typeof (agent as any).show_reasoning === 'boolean'
          ? Boolean((agent as any).show_reasoning)
          : shouldShowReasoningByDefaultForPrimaryAgent(resolvedAgentType)

      const preserve_reasoning =
        typeof (agent as any).preserve_reasoning === 'boolean'
          ? Boolean((agent as any).preserve_reasoning)
          : false
      
      const agentData = canonicalizePrimaryAgentRecord({
        ...defaultGranularSettings,  // Apply defaults first
        ...agent,  // Then override with any provided values
        agentType: resolvedAgentType,
        show_reasoning,
        preserve_reasoning: show_reasoning ? preserve_reasoning : false,
        id: agent.id!,
        user_id: agent.user_id!,
        displayName: agent.displayName!,
        created_at: agent.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }) as AgentRow
      const storageAgentData = normalizeUploadUrlsForStorageInPayload(agentData)
      
      // Store agent using RedisJSON for native JSON storage
      await client.json.set(`agent:${agent.id}`, '$', storageAgentData as any)
      
      // Add to user's agent list
      if (agentData.user_id) {
        await client.sAdd(`user:${agentData.user_id}:agents`, agentData.id)
      }
      
      // Map database fields to frontend format
      return {
        ...resolveUploadUrlsForBrowserInPayload(storageAgentData),
        displayName: storageAgentData.displayName || '',
        avatar_url: storageAgentData.avatar || storageAgentData.avatar_url || undefined
      }
    })
  }

  async updateAgent(id: string, updates: Partial<AgentRow>): Promise<void> {
    return this.execute(async (client) => {
      const existing = await client.json.get(`agent:${id}`)
      if (!existing) throw new Error('Agent not found')
      
      const updated = {
        ...(existing as any),
        ...updates,
        updated_at: new Date().toISOString()
      }

      const nullableAgentFields = [
        'buffer_size',
        'buffer_size_image',
        'zip_control_mode',
        'zip_agent_control_enabled',
        'zip_ai_view_mode',
        'zip_tool_notes_enabled',
        'zip_threshold_error',
        'zip_threshold_image',
        'zip_threshold_subagent',
        'buffer_size_error',
        'buffer_size_subagent',
        'buffer_size_read_file',
        'zip_threshold_read_file',
        'buffer_size_write_file',
        'zip_threshold_write_file',
        'buffer_size_edit_file',
        'zip_threshold_edit_file',
        'buffer_size_execute_command',
        'zip_threshold_execute_command',
        'buffer_size_list_files',
        'zip_threshold_list_files',
        'buffer_size_all_other_tools',
        'zip_threshold_all_other_tools',
        'default_project_id',
        'provider_specific_settings',
        'primary_model_temperature',
        'primary_model_preset_id',
        'primary_model_max_tokens',
        'primary_model_top_p',
        'primary_model_top_k',
        'primary_model_frequency_penalty',
        'primary_model_presence_penalty',
        'primary_model_seed',
        'primary_model_stop_sequences',
        'primary_model_reasoning_effort',
        'tool_approval_mode',
        'fallback_model_provider',
        'fallback_model_name',
        'fallback_model_preset_id',
        'fallback_model_connection',
        'fallback_model_temperature',
        'fallback_model_max_tokens',
        'fallback_model_top_p',
        'fallback_model_top_k',
        'fallback_model_frequency_penalty',
        'fallback_model_presence_penalty',
        'fallback_model_seed',
        'fallback_model_stop_sequences',
        'fallback_model_reasoning_effort',
        'fallback_model_capabilities',
        'fallback_provider_specific_settings',
        'voice_profile',
        'goon_id',
        'defaultTools'
      ]

      for (const field of nullableAgentFields) {
        if (field in updated && updated[field] === null) {
          delete updated[field]
        }
      }

      const canonicalUpdated = normalizeUploadUrlsForStorageInPayload(
        canonicalizePrimaryAgentRecord(updated)
      )
      await client.json.set(`agent:${id}`, '$', canonicalUpdated as any)
    })
  }

  async deleteAgent(id: string): Promise<void> {
    // Dynamic import avoids a redis.ts <-> memoryMedia.ts module cycle. Media cleanup
    // is part of the destructive contract: fail before deleting the agent if it fails.
    const { sweepAgentMemoryMedia } = await import('$lib/server/services/memory/memoryMedia')
    await sweepAgentMemoryMedia(id)
    return this.execute(async (client) => {
      // Get agent to find user_id
      const agent = await client.json.get(`agent:${id}`)

      // Delete agent
      await client.del(`agent:${id}`)
      await client.del(`agent:${id}:subagents`)

      // Delete the agent's memory store (SA-104, DL-104-13). Memories, graduated
      // segments, and the dreaming log are agent-scoped and survive session deletion;
      // agent deletion is the explicit lifecycle end for them. KEYS is blocking but
      // safe at single-user scale.
      for (const pattern of [`memory:${id}:*`, `memseg:${id}:*`, `memdream:${id}:*`]) {
        try {
          const memoryKeys = await client.keys(pattern)
          if (memoryKeys.length > 0) {
            await client.del(memoryKeys as [string, ...string[]])
            logger.debug(`[deleteAgent] Deleted ${memoryKeys.length} keys for ${pattern}`)
          }
        } catch (memoryError) {
          console.error(`[deleteAgent] Error deleting memory keys for ${pattern}:`, memoryError)
        }
      }
      try {
        await client.del(`memdream_index:${id}`)
      } catch (dreamIndexError) {
        console.error(`[deleteAgent] Error deleting dreaming-log index:`, dreamIndexError)
      }
      try {
        await client.del(`memfold:${id}`)
      } catch (foldError) {
        console.error(`[deleteAgent] Error deleting awareness fold:`, foldError)
      }

      // Remove from user's agent list
      const agentObj = agent as any
      if (agentObj?.user_id) {
        const userId = agentObj.user_id as string
        await client.sRem(`user:${userId}:agents`, id)

        const groupIds = await client.sMembers(`user:${userId}:groups`)
        for (const groupId of groupIds) {
          try {
            const storedGroup = await client.json.get(`group:${groupId}`)
            if (!storedGroup) continue

            const group = storedGroup as unknown as GroupChatGroupRow
            const existingAgentIds = Array.isArray(group.agent_ids) ? group.agent_ids : []
            const nextAgentIds = existingAgentIds.filter((agentId) => agentId !== id)
            const removedFromRoster = nextAgentIds.length !== existingAgentIds.length

            const existingAgentSettings =
              group.agent_settings && typeof group.agent_settings === 'object'
                ? group.agent_settings
                : {}
            const removedAgentSettings = Object.prototype.hasOwnProperty.call(
              existingAgentSettings,
              id
            )
            const nextAgentSettings = { ...existingAgentSettings }
            delete nextAgentSettings[id]

            const requestedDriverAgentId =
              typeof group.driver_agent_id === 'string' && group.driver_agent_id.trim().length > 0
                ? group.driver_agent_id.trim()
                : null
            const nextDriverAgentId = group.driver_mode
              ? requestedDriverAgentId && nextAgentIds.includes(requestedDriverAgentId)
                ? requestedDriverAgentId
                : nextAgentIds[0] ?? null
              : requestedDriverAgentId === id
                ? null
                : requestedDriverAgentId
            const driverChanged = nextDriverAgentId !== requestedDriverAgentId

            if (!removedFromRoster && !removedAgentSettings && !driverChanged) {
              continue
            }

            const updatedGroup = normalizeUploadUrlsForStorageInPayload<GroupChatGroupRow>({
              ...group,
              agent_ids: nextAgentIds,
              agent_settings: nextAgentSettings,
              driver_agent_id: nextDriverAgentId,
              updated_at: new Date().toISOString()
            })

            await client.json.set(`group:${groupId}`, '$', updatedGroup as any)
          } catch (error) {
            logger.warn(`Failed to scrub deleted agent ${id} from group ${groupId}:`, error)
          }
        }
      }
    })
  }

  // ===== GROUPS =====

  async getGroups(userId: string): Promise<GroupChatGroupRow[]> {
    return this.execute(async (client) => {
      const setKey = `user:${userId}:groups`
      const groupIds = await client.sMembers(setKey)

      if (groupIds.length === 0) {
        return []
      }

      const groups: GroupChatGroupRow[] = []
      for (const groupId of groupIds) {
        try {
          const groupData = await client.json.get(`group:${groupId}`)
          if (groupData) {
            groups.push(resolveUploadUrlsForBrowserInPayload(groupData as unknown as GroupChatGroupRow))
          }
        } catch (error) {
          logger.warn(`Failed to load group ${groupId}:`, error)
        }
      }

      groups.sort((a, b) => {
        const dateA = new Date(a.updated_at || a.created_at || 0).getTime()
        const dateB = new Date(b.updated_at || b.created_at || 0).getTime()
        return dateB - dateA
      })

      return groups
    })
  }

  async getGroup(id: string): Promise<GroupChatGroupRow | null> {
    return this.execute(async (client) => {
      const group = await client.json.get(`group:${id}`)
      return group
        ? resolveUploadUrlsForBrowserInPayload(group as unknown as GroupChatGroupRow)
        : null
    })
  }

  async createGroup(group: Partial<GroupChatGroupRow>): Promise<GroupChatGroupRow> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const maxAgents = normalizeGroupMaxAgents(group.max_agents, 4)
      const normalizedAgentIds = Array.from(
        new Set(
          (Array.isArray(group.agent_ids) ? group.agent_ids : [])
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter(Boolean)
        )
      ).slice(0, maxAgents)
      const driverMode = group.driver_mode === true
      const requestedDriverAgentId =
        typeof group.driver_agent_id === 'string' && group.driver_agent_id.trim().length > 0
          ? group.driver_agent_id.trim()
          : null
      const resolvedDriverAgentId = driverMode
        ? requestedDriverAgentId && normalizedAgentIds.includes(requestedDriverAgentId)
          ? requestedDriverAgentId
          : normalizedAgentIds[0] ?? null
        : requestedDriverAgentId
      const sharedToolsSource: unknown[] = Array.isArray(group.shared_tools)
        ? group.shared_tools
        : Array.isArray(group.zip_settings?.shared_tools)
          ? group.zip_settings.shared_tools
          : []
      const normalizedSharedTools = Array.from(
        new Set(
          sharedToolsSource
            .map((toolName: unknown) => (typeof toolName === 'string' ? toolName.trim() : ''))
            .filter((toolName): toolName is string => toolName.length > 0)
        )
      )
      const groupData: GroupChatGroupRow = {
        id: group.id!,
        user_id: group.user_id!,
        name: group.name || 'New Group',
        avatar_url:
          typeof group.avatar_url === 'string' && group.avatar_url.trim().length > 0
            ? group.avatar_url.trim()
            : undefined,
        avatar_icon_ref: group.avatar_icon_ref ?? undefined,
        avatar_icon_fit: group.avatar_icon_fit ?? undefined,
        description: group.description,
        agent_ids: normalizedAgentIds,
        agent_settings:
          group.agent_settings && typeof group.agent_settings === 'object'
            ? group.agent_settings
            : {},
        group_system_prompt:
          typeof group.group_system_prompt === 'string'
            ? group.group_system_prompt
            : undefined,
        max_followups_total: normalizeGroupMaxFollowupsTotal(group.max_followups_total, 5),
        max_agents: maxAgents,
        driver_mode: driverMode,
        driver_agent_id: resolvedDriverAgentId,
        shared_tools: normalizedSharedTools,
        zip_settings: null,
        created_at: group.created_at || now,
        updated_at: now
      }
      const storageGroupData = normalizeUploadUrlsForStorageInPayload(groupData)

      await client.json.set(`group:${groupData.id}`, '$', storageGroupData as any)
      await client.sAdd(`user:${groupData.user_id}:groups`, groupData.id)

      return resolveUploadUrlsForBrowserInPayload(storageGroupData)
    })
  }

  async updateGroup(id: string, updates: Partial<GroupChatGroupRow>): Promise<void> {
    return this.execute(async (client) => {
      const existing = await client.json.get(`group:${id}`)
      if (!existing) throw new Error('Group not found')

      const merged = {
        ...(existing as unknown as GroupChatGroupRow),
        ...updates
      }
      const maxAgents = normalizeGroupMaxAgents(merged.max_agents, 4)
      const normalizedAgentIds = Array.from(
        new Set(
          (Array.isArray(merged.agent_ids) ? merged.agent_ids : [])
            .map((agentId) => (typeof agentId === 'string' ? agentId.trim() : ''))
            .filter(Boolean)
        )
      ).slice(0, maxAgents)
      const driverMode = merged.driver_mode === true
      const requestedDriverAgentId =
        typeof merged.driver_agent_id === 'string' && merged.driver_agent_id.trim().length > 0
          ? merged.driver_agent_id.trim()
          : null
      const resolvedDriverAgentId = driverMode
        ? requestedDriverAgentId && normalizedAgentIds.includes(requestedDriverAgentId)
          ? requestedDriverAgentId
          : normalizedAgentIds[0] ?? null
        : requestedDriverAgentId
      const sharedToolsSource: unknown[] = Array.isArray(merged.shared_tools)
        ? merged.shared_tools
        : Array.isArray((merged as any)?.zip_settings?.shared_tools)
          ? (merged as any).zip_settings.shared_tools
          : []
      const normalizedSharedTools = Array.from(
        new Set(
          sharedToolsSource
            .map((toolName: unknown) => (typeof toolName === 'string' ? toolName.trim() : ''))
            .filter((toolName): toolName is string => toolName.length > 0)
        )
      )

      const updated: GroupChatGroupRow = {
        ...merged,
        avatar_url:
          typeof merged.avatar_url === 'string' && merged.avatar_url.trim().length > 0
            ? merged.avatar_url.trim()
            : undefined,
        avatar_icon_ref: merged.avatar_icon_ref ?? undefined,
        avatar_icon_fit: merged.avatar_icon_fit ?? undefined,
        agent_ids: normalizedAgentIds,
        max_followups_total: normalizeGroupMaxFollowupsTotal(merged.max_followups_total, 5),
        max_agents: maxAgents,
        driver_mode: driverMode,
        driver_agent_id: resolvedDriverAgentId,
        shared_tools: normalizedSharedTools,
        zip_settings: null,
        updated_at: new Date().toISOString()
      }
      const storageUpdated = normalizeUploadUrlsForStorageInPayload(updated)

      await client.json.set(`group:${id}`, '$', storageUpdated as any)
    })
  }

  async deleteGroup(id: string): Promise<void> {
    return this.execute(async (client) => {
      const group = await client.json.get(`group:${id}`)
      await client.del(`group:${id}`)

      const groupObj = group as any
      if (groupObj?.user_id) {
        await client.sRem(`user:${groupObj.user_id}:groups`, id)
      }
    })
  }

  // ===== VOICE PROFILES =====

  async getVoiceProfiles(userId: string): Promise<VoiceProfileRecord[]> {
    return this.execute(async (client) => {
      const setKey = `user:${userId}:voice_profiles`
      const profileIds = await client.sMembers(setKey)

      if (profileIds.length === 0) {
        return []
      }

      const profiles: VoiceProfileRecord[] = []
      for (const profileId of profileIds) {
        try {
          const profile = await client.json.get(`voice_profile:${profileId}`)
          if (profile) {
            profiles.push(profile as unknown as VoiceProfileRecord)
          }
        } catch (error) {
          logger.warn(`Failed to load voice profile ${profileId}:`, error)
        }
      }

      profiles.sort((a, b) => {
        const dateA = new Date(a.updated_at || a.created_at || 0).getTime()
        const dateB = new Date(b.updated_at || b.created_at || 0).getTime()
        return dateB - dateA
      })

      return profiles
    })
  }

  async getVoiceProfile(id: string): Promise<VoiceProfileRecord | null> {
    return this.execute(async (client) => {
      const profile = await client.json.get(`voice_profile:${id}`)
      return (profile as unknown as VoiceProfileRecord) ?? null
    })
  }

  async createVoiceProfile(profile: VoiceProfileRecord): Promise<VoiceProfileRecord> {
    return this.execute(async (client) => {
      await client.json.set(`voice_profile:${profile.id}`, '$', profile as any)
      await client.sAdd(`user:${profile.user_id}:voice_profiles`, profile.id)
      return profile
    })
  }

  async deleteVoiceProfile(id: string, userId: string): Promise<void> {
    return this.execute(async (client) => {
      await client.del(`voice_profile:${id}`)
      await client.sRem(`user:${userId}:voice_profiles`, id)
    })
  }

  // ===== USER SETTINGS =====

  async getUserSettings(userId: string): Promise<UserSettingsRow | null> {
    try {
      const settings = await this.json.get(`user:${userId}:settings`, '$')
      return settings
        ? resolveUploadUrlsForBrowserInPayload(settings as UserSettingsRow)
        : null
    } catch (error) {
      // Null strictly means "no settings saved yet". Redis failures rethrow so callers
      // fail loudly instead of treating an outage as an empty profile — a swallowed read
      // here also let updateUserSettings rebuild from null and wipe saved fields (G-0031).
      console.error('Error getting user settings:', error)
      throw error
    }
  }

  async updateUserSettings(userId: string, updates: { 
    displayName?: string | null, 
    avatar_url?: string | null, 
    avatar_icon_ref?: UserSettingsRow['avatar_icon_ref'],
    avatar_icon_fit?: UserSettingsRow['avatar_icon_fit'],
    always_show_zip_borders?: boolean,
    show_zip_visual_indicators?: boolean,
    // New visual indicator settings
    show_zipped_badges?: boolean,
    zipped_badges_hover_only?: boolean,
    show_zipped_borders?: boolean,
    zipped_borders_hover_only?: boolean,
    show_unzipped_badges?: boolean,
    unzipped_badges_hover_only?: boolean,
    show_unzipped_borders?: boolean,
    unzipped_borders_hover_only?: boolean,
    // Global zip settings
    global_zip_settings?: any,
    global_auto_compact_settings?: any,
    global_tool_grid_settings?: any,
    ui_settings?: any,
    admin_settings?: any,
    global_custom_system_prompt?: string,
    upload_settings?: any,
    upload_provider?: string,
    voice_settings?: VoiceSettings,
    goons_settings?: GoonsSettings,
    onboarding_settings?: UserSettingsRow['onboarding_settings']
  }): Promise<UserSettingsRow> {
    return this.execute(async (client) => {
      // Get existing or create new with defaults
      const existing = await this.getUserSettings(userId)
      
      const settingsData: UserSettingsRow = {
        id: existing?.id || `settings_${userId}`,
        user_id: userId,
        displayName: updates.displayName !== undefined ? (updates.displayName === null ? undefined : updates.displayName) : existing?.displayName,
        avatar_url: updates.avatar_url !== undefined ? (updates.avatar_url === null ? undefined : updates.avatar_url) : existing?.avatar_url,
        avatar_icon_ref: updates.avatar_icon_ref !== undefined ? updates.avatar_icon_ref : existing?.avatar_icon_ref,
        avatar_icon_fit: updates.avatar_icon_fit !== undefined ? updates.avatar_icon_fit : existing?.avatar_icon_fit,
        always_show_zip_borders: updates.always_show_zip_borders !== undefined ? updates.always_show_zip_borders : existing?.always_show_zip_borders,
        // New visual indicator settings
        show_zipped_badges: updates.show_zipped_badges !== undefined ? updates.show_zipped_badges : existing?.show_zipped_badges,
        zipped_badges_hover_only: updates.zipped_badges_hover_only !== undefined ? updates.zipped_badges_hover_only : existing?.zipped_badges_hover_only,
        show_zipped_borders: updates.show_zipped_borders !== undefined ? updates.show_zipped_borders : existing?.show_zipped_borders,
        zipped_borders_hover_only: updates.zipped_borders_hover_only !== undefined ? updates.zipped_borders_hover_only : existing?.zipped_borders_hover_only,
        show_unzipped_badges: updates.show_unzipped_badges !== undefined ? updates.show_unzipped_badges : existing?.show_unzipped_badges,
        unzipped_badges_hover_only: updates.unzipped_badges_hover_only !== undefined ? updates.unzipped_badges_hover_only : existing?.unzipped_badges_hover_only,
        show_unzipped_borders: updates.show_unzipped_borders !== undefined ? updates.show_unzipped_borders : existing?.show_unzipped_borders,
        unzipped_borders_hover_only: updates.unzipped_borders_hover_only !== undefined ? updates.unzipped_borders_hover_only : existing?.unzipped_borders_hover_only,
        // Global zip settings
        global_zip_settings: updates.global_zip_settings !== undefined ? updates.global_zip_settings : existing?.global_zip_settings,
        global_auto_compact_settings:
          updates.global_auto_compact_settings !== undefined
            ? updates.global_auto_compact_settings
            : (existing as any)?.global_auto_compact_settings,
        global_tool_grid_settings:
          updates.global_tool_grid_settings !== undefined
            ? updates.global_tool_grid_settings
            : existing?.global_tool_grid_settings,
        ui_settings: updates.ui_settings !== undefined ? updates.ui_settings : existing?.ui_settings,
        admin_settings: updates.admin_settings !== undefined ? updates.admin_settings : (existing as any)?.admin_settings,
        global_custom_system_prompt: updates.global_custom_system_prompt !== undefined ? updates.global_custom_system_prompt : existing?.global_custom_system_prompt,
        upload_settings: updates.upload_settings !== undefined ? updates.upload_settings : existing?.upload_settings,
        upload_provider: updates.upload_provider !== undefined ? updates.upload_provider : existing?.upload_provider,
        voice_settings: updates.voice_settings !== undefined ? updates.voice_settings : existing?.voice_settings,
        goons_settings: updates.goons_settings !== undefined ? updates.goons_settings : (existing as any)?.goons_settings,
        onboarding_settings:
          updates.onboarding_settings !== undefined
            ? updates.onboarding_settings
            : (existing as any)?.onboarding_settings,
        created_at: existing?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      
      // Handle show_zip_visual_indicators as part of ui_settings
      if (updates.show_zip_visual_indicators !== undefined) {
        settingsData.ui_settings = settingsData.ui_settings || {}
        settingsData.ui_settings.show_zip_visual_indicators = updates.show_zip_visual_indicators
      }
      
      const storageSettingsData = normalizeUploadUrlsForStorageInPayload(settingsData)
      await client.json.set(`user:${userId}:settings`, '$', storageSettingsData as any)
      
      return resolveUploadUrlsForBrowserInPayload(storageSettingsData)
    })
  }

  async saveUserSettings(userId: string, completeSettings: any): Promise<UserSettingsRow> {
    return this.execute(async (client) => {
      const user = await this.getUserSettings(userId)
      const updated: UserSettingsRow = {
        id: user?.id || `settings_${userId}`,
        user_id: userId,
        displayName: user?.displayName,
        avatar_url: user?.avatar_url,
        avatar_icon_ref: user?.avatar_icon_ref,
        avatar_icon_fit: user?.avatar_icon_fit,
        always_show_zip_borders: user?.always_show_zip_borders,
        global_custom_system_prompt: user?.global_custom_system_prompt,
        global_auto_compact_settings: (user as any)?.global_auto_compact_settings,
        ui_settings: completeSettings, // Replace entire settings object
        admin_settings: (user as any)?.admin_settings,
        upload_settings: user?.upload_settings,
        upload_provider: user?.upload_provider,
        voice_settings: user?.voice_settings,
        goons_settings: (user as any)?.goons_settings,
        created_at: user?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      
      const storageUpdated = normalizeUploadUrlsForStorageInPayload(updated)
      await client.json.set(`user:${userId}:settings`, '$', storageUpdated as any)
      return resolveUploadUrlsForBrowserInPayload(storageUpdated)
    })
  }

  // ===== PROJECTS =====

  async getProjects(userId: string): Promise<ProjectRow[]> {
    return this.execute(async (client) => {
      // Get all project keys for this user
      const pattern = `project:${userId}:*`
      const keys = await client.keys(pattern)
      
      if (keys.length === 0) {
        return []
      }
      
      // Get all project data using RedisJSON
      const projects: ProjectRow[] = []
      for (const key of keys) {
        try {
          const projectData = await client.json.get(key)
          if (projectData) {
            projects.push(projectData as unknown as ProjectRow)
          }
        } catch (error) {
          logger.warn(`Failed to load project ${key}:`, error)
        }
      }
      
      return projects.sort((a, b) => 
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
    })
  }

  async saveProject(project: ProjectRow): Promise<ProjectRow> {
    return this.execute(async (client) => {
      const key = `project:${project.user_id}:${project.id}`
      await client.json.set(key, '$', project as any)
      return project
    })
  }

  async updateProject(projectId: string, userId: string, updates: Partial<ProjectRow>): Promise<ProjectRow> {
    return this.execute(async (client) => {
      const key = `project:${userId}:${projectId}`
      
      // Get existing project
      const existing = await client.json.get(key)
      if (!existing) throw new Error('Project not found')
      
      // Merge updates
      const updated = {
        ...(existing as any),
        ...updates,
        updated_at: new Date().toISOString()
      }
      
      // Save back
      await client.json.set(key, '$', updated as any)
      
      return updated as ProjectRow
    })
  }

  async deleteProject(projectId: string, userId: string): Promise<void> {
    return this.execute(async (client) => {
      const key = `project:${userId}:${projectId}`
      await client.del(key)
    })
  }

  async getProjectPreferences(userId: string): Promise<ProjectPreferences | null> {
    return this.execute(async (client) => {
      try {
        const prefs = await client.json.get(`project_prefs:${userId}`)
        if (!isProjectPreferences(prefs)) {
          if (prefs) {
            logger.warn('[Redis] Project preferences missing required fields', { userId })
          }
          return null
        }
        return prefs
      } catch (error) {
        console.error('[Redis] Failed to load project preferences:', error)
        return null
      }
    })
  }

  async saveProjectPreferences(
    userId: string,
    updates: { default_workspace_path?: string | null }
  ): Promise<ProjectPreferences> {
    return this.execute(async (client) => {
      const key = `project_prefs:${userId}`
      const existing = (await client.json.get(key)) as ProjectPreferences | null
      const now = new Date().toISOString()
      const trimmed = updates.default_workspace_path?.trim()
      const prefs: ProjectPreferences = {
        user_id: userId,
        default_workspace_path: trimmed && trimmed.length > 0 ? trimmed : undefined,
        created_at: existing?.created_at ?? now,
        updated_at: now
      }
      await client.json.set(key, '$', prefs as any)
      return prefs
    })
  }

  // ===== REDIS OPERATIONS =====

  // Generic Redis operations for system prompts and other data
  async get(key: string): Promise<any> {
    return this.execute(async (client) => {
      try {
        // First check if the key exists and what type it is
        const exists = await client.exists(key)
        if (!exists) return null
        
        const type = await client.type(key)
        
        // If it's a JSON type, use JSON.GET.
        // Different Redis clients/adapters can report this as ReJSON-RL or json.
        if (type === 'ReJSON-RL' || type === 'json' || type === 'JSON') {
          const value = await client.json.get(key)
          return value
        } else {
          // Regular strings (system prompts, simple values)
          const value = await client.get(key)
          return this.safeJsonParse(value)
        }
      } catch (error) {
        console.error('Error getting key:', key, error)
        return null
      }
    })
  }

  async set(key: string, value: any): Promise<void> {
    return this.execute(async (client) => {
      if (typeof value === 'object' && value !== null) {
        // Store objects using RedisJSON for native JSON operations
        await client.json.set(key, '$', value)
      } else {
        // Store strings and primitives as regular Redis strings (system prompts, etc.)
        await client.set(key, String(value))
      }
    })
  }

  async del(key: string): Promise<void> {
    return this.execute(async (client) => {
      await client.del(key)
    })
  }

  async exists(key: string): Promise<boolean> {
    return this.execute(async (client) => {
      return (await client.exists(key)) === 1
    })
  }

  async keys(pattern: string): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.keys(pattern)
    })
  }

  // Set operations
  async sMembers(key: string): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.sMembers(key)
    })
  }

  async sAdd(key: string, member: string): Promise<void> {
    return this.execute(async (client) => {
      await client.sAdd(key, member)
    })
  }

  async sRem(key: string, member: string): Promise<void> {
    return this.execute(async (client) => {
      await client.sRem(key, member)
    })
  }

  // List operations
  async lRange(key: string, start: number = 0, stop: number = -1): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.lRange(key, start, stop)
    })
  }

  async rPush(key: string, element: string): Promise<void> {
    return this.execute(async (client) => {
      await client.rPush(key, element)
    })
  }

  async lRem(key: string, count: number, element: string): Promise<void> {
    return this.execute(async (client) => {
      await client.lRem(key, count, element)
    })
  }

  // ===== FOLDERS =====

  async getFolders(userId: string): Promise<ChatFolderRow[]> {
    return this.execute(async (client) => {
      try {
        // Get all folder IDs for user
        const folderIds = await client.sMembers(`user:${userId}:folders`)
        
        if (!folderIds || folderIds.length === 0) {
          // Create default folder if none exist
          const defaultFolder = await this.createDefaultFolder(userId)
          return [defaultFolder]
        }

        const folders: ChatFolderRow[] = []
        for (const folderId of folderIds) {
          const folder = await client.json.get(`folder:${userId}:${folderId}`)
          if (folder) {
            const folderData = folder as unknown as ChatFolderRow
            
            // Count sessions in folder (excluding archived)
            const sessionIds = await client.sMembers(`folder:${userId}:${folderId}:sessions`)
            let chatCount = 0
            let latestSessionAt: string | undefined
            for (const sessionId of sessionIds) {
              const session = await client.json.get(`session:${sessionId}`)
              if (session) {
                const sessionData = session as unknown as ChatSessionRow
                if (!sessionData.archived) {
                  chatCount++
                  latestSessionAt = this.newestTimestamp(
                    latestSessionAt,
                    sessionData.last_modified_at,
                    sessionData.created_at
                  )
                }
              }
            }
            folderData.chat_count = chatCount
            folderData.last_used_at =
              this.newestTimestamp(folderData.last_used_at, latestSessionAt, folderData.created_at) ??
              folderData.created_at
            
            folders.push(folderData)
          }
        }

        this.sortFoldersForDisplay(folders)
        
        return folders
      } catch (error) {
        console.error('[getFolders] Error:', error)
        // Return default folder on error
        const defaultFolder = await this.createDefaultFolder(userId)
        return [defaultFolder]
      }
    })
  }

  async getFolder(userId: string, folderId: string): Promise<ChatFolderRow | null> {
    return this.execute(async (client) => {
      try {
        const folder = await client.json.get(`folder:${userId}:${folderId}`)
        if (!folder) return null
        
        const folderData = folder as unknown as ChatFolderRow
        
        // Count sessions in folder
        const sessionIds = await client.sMembers(`folder:${userId}:${folderId}:sessions`)
        let chatCount = 0
        for (const sessionId of sessionIds) {
          const session = await client.json.get(`session:${sessionId}`)
          if (session) {
            const sessionData = session as unknown as ChatSessionRow
            if (!sessionData.archived) {
              chatCount++
            }
          }
        }
        folderData.chat_count = chatCount
        
        return folderData
      } catch (error) {
        console.error('[getFolder] Error:', error)
        return null
      }
    })
  }

  async createFolder(folder: ChatFolderRow): Promise<ChatFolderRow> {
    return this.execute(async (client) => {
      try {
        const now = new Date().toISOString()
        const folderToStore: ChatFolderRow = {
          ...folder,
          created_at: folder.created_at || now,
          last_used_at: folder.last_used_at || folder.created_at || now
        }

        // Store folder
        await client.json.set(`folder:${folder.user_id}:${folder.id}`, '$', folderToStore as any)
        
        // Add to user's folder set
        await client.sAdd(`user:${folder.user_id}:folders`, folder.id)
        
        // If this is the default folder, store its ID
        if (folderToStore.is_default) {
          await client.set(`user:${folder.user_id}:default_folder`, folder.id)
        }
        
        return folderToStore
      } catch (error) {
        console.error('[createFolder] Error:', error)
        throw error
      }
    })
  }

  async updateFolder(userId: string, folderId: string, updates: Partial<ChatFolderRow>): Promise<ChatFolderRow | null> {
    return this.execute(async (client) => {
      try {
        const folder = await client.json.get(`folder:${userId}:${folderId}`)
        if (!folder) return null
        
        const folderData = folder as unknown as ChatFolderRow
        
        // Update allowed fields
        if (updates.name !== undefined) folderData.name = updates.name
        if (updates.sort_order !== undefined) folderData.sort_order = updates.sort_order
        if (updates.is_expanded !== undefined) folderData.is_expanded = updates.is_expanded
        if (updates.is_default !== undefined) folderData.is_default = updates.is_default
        
        folderData.updated_at = new Date().toISOString()
        
        // Save updated folder
        await client.json.set(`folder:${userId}:${folderId}`, '$', folderData as any)
        
        return folderData
      } catch (error) {
        console.error('[updateFolder] Error:', error)
        return null
      }
    })
  }

  async deleteFolder(
    userId: string,
    folderId: string,
    options: { deleteSessions?: boolean } = {}
  ): Promise<{
    success: boolean
    moved_to?: string
    deleted_sessions?: number
    error?: string
  }> {
    if (options.deleteSessions) {
      const validation = await this.execute(async (client) => {
        try {
          const folder = await client.json.get(`folder:${userId}:${folderId}`)
          if (!folder) {
            return { success: false as const, error: 'Folder not found', sessionIds: [] as string[] }
          }

          const folderData = folder as unknown as ChatFolderRow
          if (folderData.is_default) {
            console.error('[deleteFolder] Cannot delete default folder')
            return {
              success: false as const,
              error: 'Cannot delete default folder',
              sessionIds: [] as string[]
            }
          }

          const rawSessionIds = await client.sMembers(`folder:${userId}:${folderId}:sessions`)
          const sessionIds: string[] = []
          const lockedSessionIds: string[] = []

          for (const sessionId of rawSessionIds) {
            const session = await client.json.get(`session:${sessionId}`)
            if (!session) continue

            const sessionData = session as unknown as ChatSessionRow
            if (sessionData.user_id && sessionData.user_id !== userId) continue

            sessionIds.push(sessionId)
            if (sessionData.locked) {
              lockedSessionIds.push(sessionId)
            }
          }

          if (lockedSessionIds.length > 0) {
            return {
              success: false as const,
              error:
                lockedSessionIds.length === 1
                  ? 'Folder contains a locked session. Unlock it before deleting the folder and sessions.'
                  : `Folder contains ${lockedSessionIds.length} locked sessions. Unlock them before deleting the folder and sessions.`,
              sessionIds
            }
          }

          return { success: true as const, sessionIds }
        } catch (error) {
          console.error('[deleteFolder] Error validating delete-with-sessions:', error)
          return {
            success: false as const,
            error: 'Failed to validate folder deletion',
            sessionIds: [] as string[]
          }
        }
      })

      if (!validation.success) {
        return { success: false, error: validation.error }
      }

      for (const sessionId of validation.sessionIds) {
        await this.deleteSession(sessionId)
      }

      return this.execute(async (client) => {
        try {
          await client.del(`folder:${userId}:${folderId}`)
          await client.del(`folder:${userId}:${folderId}:sessions`)
          await client.sRem(`user:${userId}:folders`, folderId)

          return {
            success: true,
            deleted_sessions: validation.sessionIds.length
          }
        } catch (error) {
          console.error('[deleteFolder] Error deleting folder after sessions:', error)
          return { success: false, error: 'Failed to delete folder' }
        }
      })
    }

    return this.execute(async (client) => {
      try {
        // Get folder to check if it's default
        const folder = await client.json.get(`folder:${userId}:${folderId}`)
        if (!folder) {
          return { success: false, error: 'Folder not found' }
        }
        
        const folderData = folder as unknown as ChatFolderRow
        
        // Cannot delete default folder
        if (folderData.is_default) {
          console.error('[deleteFolder] Cannot delete default folder')
          return { success: false, error: 'Cannot delete default folder' }
        }
        
        // Get or create default folder
        let defaultFolderId = await client.get(`user:${userId}:default_folder`)
        
        if (!defaultFolderId) {
          // Create default folder if it doesn't exist
          const defaultFolder = await this.createDefaultFolder(userId)
          defaultFolderId = defaultFolder.id
        }
        
        // Move all sessions from this folder to default folder
        const sessionIds = await client.sMembers(`folder:${userId}:${folderId}:sessions`)
        
        for (const sessionId of sessionIds) {
          const session = await client.json.get(`session:${sessionId}`)
          if (session) {
            const sessionData = session as unknown as ChatSessionRow
            sessionData.folder_id = defaultFolderId
            await client.json.set(`session:${sessionId}`, '$', sessionData as any)
            await client.sAdd(`folder:${userId}:${defaultFolderId}:sessions`, sessionId)
          }
        }
        await this.touchFolderLastUsed(client, userId, defaultFolderId)
        
        // Delete folder references
        await client.del(`folder:${userId}:${folderId}`)
        await client.del(`folder:${userId}:${folderId}:sessions`)
        await client.sRem(`user:${userId}:folders`, folderId)
        
        return { success: true, moved_to: defaultFolderId }
      } catch (error) {
        console.error('[deleteFolder] Error:', error)
        return { success: false, error: 'Failed to delete folder' }
      }
    })
  }

  async getDefaultFolder(userId: string): Promise<ChatFolderRow> {
    return this.execute(async (client) => {
      try {
        // Check for existing default folder
        const defaultFolderId = await client.get(`user:${userId}:default_folder`)
        
        if (defaultFolderId) {
          const folder = await client.json.get(`folder:${userId}:${defaultFolderId}`)
          if (folder) {
            return folder as unknown as ChatFolderRow
          }
        }
        
        // Create default folder if it doesn't exist
        return await this.createDefaultFolder(userId)
      } catch (error) {
        console.error('[getDefaultFolder] Error:', error)
        // Always return a default folder
        return await this.createDefaultFolder(userId)
      }
    })
  }

  private async createDefaultFolder(userId: string): Promise<ChatFolderRow> {
    return this.execute(async (client) => {
      const folderId = crypto.randomUUID()
      
      const now = new Date().toISOString()
      const defaultFolder: ChatFolderRow = {
        id: folderId,
        user_id: userId,
        name: 'My Chats',
        is_default: true,
        is_expanded: true,
        sort_order: 0,
        last_used_at: now,
        created_at: now,
        chat_count: 0
      }
      
      await client.json.set(`folder:${userId}:${folderId}`, '$', defaultFolder as any)
      await client.sAdd(`user:${userId}:folders`, folderId)
      await client.set(`user:${userId}:default_folder`, folderId)
      
      return defaultFolder
    })
  }

  async setDefaultFolder(userId: string, folderId: string): Promise<boolean> {
    return this.execute(async (client) => {
      try {
        await client.set(`user:${userId}:default_folder`, folderId)
        return true
      } catch (error) {
        console.error('[setDefaultFolder] Error:', error)
        return false
      }
    })
  }

  async moveSessionToFolder(sessionId: string, fromFolderId: string | null, toFolderId: string, userId: string): Promise<boolean> {
    return this.execute(async (client) => {
      try {
        // Get session
        const session = await client.json.get(`session:${sessionId}`)
        if (!session) return false
        
        const sessionData = session as unknown as ChatSessionRow
        
        // Remove from old folder if exists
        if (fromFolderId && fromFolderId !== toFolderId) {
          await client.sRem(`folder:${userId}:${fromFolderId}:sessions`, sessionId)
        }
        
        // Update session's folder_id
        sessionData.folder_id = toFolderId
        await client.json.set(`session:${sessionId}`, '$', sessionData as any)
        
        // Add to new folder
        await client.sAdd(`folder:${userId}:${toFolderId}:sessions`, sessionId)
        await this.touchFolderLastUsed(client, userId, toFolderId)
        
        return true
      } catch (error) {
        console.error('[moveSessionToFolder] Error:', error)
        return false
      }
    })
  }

  // ===== ZIPS =====
  
  async createZip(zip: {
    id: string
    content: string
    type: string
    tokens: number
    description: string
    metadata?: any
  }): Promise<void> {
    return this.execute(async (client) => {
      // NO MORE NORMALIZATION! Each zip has a unique ID now
      // We're using timestamp + random string, so no duplicates possible
      
      const zipData = {
        ...zip,
        created_at: new Date().toISOString()
      }
      
      // Store using RedisJSON for native JSON operations
      // Each zip has a unique ID, no overwriting issues
      await client.json.set(`zip:${zip.id}`, '$', zipData as any)
      
      // Add to session's zip set if sessionId is provided
      if (zip.metadata?.sessionId) {
        await client.sAdd(`session:${zip.metadata.sessionId}:zips`, zip.id)
      }
      
      // NO TTL - zips persist until session is deleted
      // Zips are cleaned up when their session is deleted
    })
  }
  
  async getZip(zipId: string): Promise<any> {
    return this.execute(async (client) => {
      try {
        // NO NORMALIZATION - fetch with exact ID
        const key = `zip:${zipId}`
        const zipData = await client.json.get(key)
        if (!zipData) {
          console.warn(`[Redis] Zip not found for id ${zipId} (key: ${key})`)
        }
        return zipData
      } catch (error) {
        console.error(`[Redis] Error getting zip ${zipId}:`, error)
        return null
      }
    })
  }
  
  async getZips(zipIds: string[]): Promise<Map<string, any>> {
    return this.execute(async (client) => {
      const results = new Map()
      
      // DON'T normalize - just fetch with the exact IDs provided
      logger.debug('[Redis.getZips] Fetching zip IDs:', zipIds)
      
      // Fetch each zip individually - simpler and more reliable than pipeline
      for (const zipId of zipIds) {
        try {
          const data = await client.json.get(`zip:${zipId}`)
          if (data) {
            logger.debug(`[Redis.getZips] Found data for ${zipId}`)
            results.set(zipId, data)
          } else {
            logger.debug(`[Redis.getZips] No data for ${zipId}`)
          }
        } catch (error) {
          logger.debug(`[Redis.getZips] Error fetching ${zipId}:`, error)
        }
      }
      
      logger.debug('[Redis.getZips] Returning results for', results.size, 'zips')
      return results
    })
  }
  
  async deleteZip(zipId: string): Promise<void> {
    return this.execute(async (client) => {
      // NO NORMALIZATION - delete with exact ID
      
      // Get zip data to find session
      const zipData = await client.json.get(`zip:${zipId}`)
      
      // Remove from session's zip set if it exists
      const zipDataObj = zipData as any
      if (zipDataObj && zipDataObj.metadata?.sessionId) {
        await client.sRem(`session:${zipDataObj.metadata.sessionId}:zips`, zipId)
      }
      
      // Delete the zip
      await client.del(`zip:${zipId}`)
    })
  }
  
  async getSessionZips(sessionId: string): Promise<string[]> {
    return this.execute(async (client) => {
      const zipIds = await client.sMembers(`session:${sessionId}:zips`)
      return zipIds || []
    })
  }

  // Connection management
  async disconnect(): Promise<void> {
    if (this.client) {
      const client = this.client
      this.client = null
      if (client.isOpen) {
        await client.disconnect()
      }
    }
  }

  // Health check
  async ping(): Promise<string> {
    return this.execute(async (client) => {
      return await client.ping()
    })
  }

  // Set operations (for MCP tracking)
  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.execute(async (client) => {
      return await client.sAdd(key, members)
    })
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.execute(async (client) => {
      return await client.sRem(key, members)
    })
  }

  async smembers(key: string): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.sMembers(key)
    })
  }

  async sismember(key: string, member: string): Promise<boolean> {
    return this.execute(async (client) => {
      const result = await client.sIsMember(key, member)
      return result === 1
    })
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.execute(async (client) => {
      return await client.lPush(key, values)
    })
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.lRange(key, start, stop)
    })
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    return this.execute(async (client) => {
      return await client.lTrim(key, start, stop)
    })
  }

  // JSON operations (for Redis 8 Stack with RedisJSON)
  json = {
    get: async (key: string, path: string = '$'): Promise<any> => {
      return this.execute(async (client) => {
        const result = await client.json.get(key, { path })
        // JSONPath $ returns array - unwrap if single result at root
        if (path === '$' && Array.isArray(result) && result.length === 1) {
          return result[0]
        }
        return result
      })
    },
    set: async (key: string, path: string, value: any): Promise<string | null> => {
      return this.execute(async (client) => {
        return await client.json.set(key, path, value)
      })
    }
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    return this.execute(async (client) => {
      const result = await client.expire(key, seconds)
      return result === 1
    })
  }

  async ttl(key: string): Promise<number> {
    return this.execute(async (client) => {
      return await client.ttl(key)
    })
  }

  async incr(key: string): Promise<number> {
    return this.execute(async (client) => {
      return await client.incr(key)
    })
  }
}

export async function disconnectAllRedisServices(): Promise<void> {
  await RedisService.disconnectAll()
}

// Export singleton instance
export const redis = new RedisService()
