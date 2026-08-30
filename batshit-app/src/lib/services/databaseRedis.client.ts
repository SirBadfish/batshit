// Browser-side database facade for Redis-backed Batshit data.
//
// SA-106 P2: this file used to hold a full second implementation of
// `buildFormattedChatInput` — the client compile twin, ~2,800 lines that mirrored
// `databaseRedis.server.ts` and existed only to compile the n8n Primary lane in the
// browser (its own comment said so). That lane is retired, its single caller
// (`messageApi.ts`) is gone, and the server implementation is now the ONE compile path.
//
// What remains is what it always also was: a thin CRUD facade delegating to the focused
// service clients. Keep it that way — this module is client-reachable, so it must never
// import from `$lib/server`.

import { sessionApiClient } from './sessionApiClient'
import { messageApiClient } from './messageApiClient'
import { agentStore } from './agentStore'
import { userStore } from './userStore'

import type {
  ChatMemoryRow,
  ChatSessionRow,
  ChatFolderRow,
  ClipRow,
  SubagentRow
} from '$lib/types/database'
import type { AgentRow } from '$lib/types/database'
import type { Message } from '$lib/stores/messages.svelte'

/**
 * DatabaseService - browser CRUD facade over the focused store clients.
 */
export class DatabaseService {
  private apiUrl = '/api'
  private customFetch?: typeof fetch
  constructor(fetcher?: typeof fetch) {
    this.customFetch = fetcher
    if (fetcher) {
      sessionApiClient.configureApi(fetcher, this.apiUrl)
      messageApiClient.configureApi(fetcher, this.apiUrl)
      agentStore.configureApi(fetcher, this.apiUrl)
      userStore.configureApi(fetcher, this.apiUrl)
    }
  }

  async getSessions(userId: string, includeArchived = false) {
    return sessionApiClient.getSessions(userId, includeArchived)
  }

  async createSession(session: Partial<ChatSessionRow>) {
    return sessionApiClient.createSession(session)
  }

  async updateSession(id: string, updates: Partial<ChatSessionRow>) {
    return sessionApiClient.updateSession(id, updates)
  }

  async deleteSession(id: string) {
    return sessionApiClient.deleteSession(id)
  }

  async archiveSession(id: string) {
    return sessionApiClient.archiveSession(id)
  }

  async unarchiveSession(id: string) {
    return sessionApiClient.unarchiveSession(id)
  }

  async touchSession(sessionId: string) {
    return sessionApiClient.touchSession(sessionId)
  }

  // ========== Message Operations - Delegate to messageApiClient ==========
  async getMessages(sessionId: string, limit = 100) {
    return messageApiClient.getMessages(sessionId, limit)
  }

  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return messageApiClient.getSessionMessages(sessionId)
  }

  async saveMessage(message: Message | Partial<ChatMemoryRow>, agent?: any) {
    return messageApiClient.saveMessage(message, agent)
  }

  async updateMessage(messageId: string, sessionId: string, updates: Partial<ChatMemoryRow>, userId: string) {
    return messageApiClient.updateMessage(messageId, sessionId, updates, userId)
  }

  async deleteMessage(messageId: string, sessionId: string, userId: string) {
    return messageApiClient.deleteMessage(messageId, sessionId, userId)
  }

  // ========== Agent Operations - Delegate to agentStore ==========
  async getAgents(userId: string) {
    return agentStore.getAgents(userId)
  }

  async createAgent(agent: Partial<AgentRow>) {
    return agentStore.createAgent(agent)
  }

  async updateAgent(id: string, updates: Partial<AgentRow>) {
    return agentStore.updateAgent(id, updates)
  }

  async deleteAgent(id: string) {
    return agentStore.deleteAgent(id)
  }

  async getSubagents(userId: string) {
    return agentStore.getSubagents(userId)
  }

  async createSubagent(subagent: Partial<SubagentRow>) {
    return agentStore.createSubagent(subagent)
  }

  async updateSubagent(id: string, updates: Partial<SubagentRow>) {
    return agentStore.updateSubagent(id, updates)
  }

  async deleteSubagent(id: string) {
    return agentStore.deleteSubagent(id)
  }

  // ========== User Operations - Delegate to userStore ==========
  async getUserSettings(userId: string) {
    return userStore.getUserSettings(userId)
  }

  async updateUserSettings(userId: string, updates: any) {
    return userStore.updateUserSettings(userId, updates)
  }

  async getProjects(userId: string) {
    return userStore.getProjects(userId)
  }

  async saveProject(project: any) {
    return userStore.saveProject(project)
  }

  async updateProject(projectId: string, userId: string, updates: any) {
    return userStore.updateProject(projectId, userId, updates)
  }

  async deleteProject(projectId: string, userId: string) {
    return userStore.deleteProject(projectId, userId)
  }

  async getClips(userId: string) {
    return userStore.getClips(userId)
  }

  async getClip(clipId: string) {
    return userStore.getClip(clipId)
  }

  async createClip(clip: Partial<ClipRow>) {
    return userStore.createClip(clip)
  }

  async updateClip(clipId: string, updates: Partial<ClipRow>) {
    return userStore.updateClip(clipId, updates)
  }

  async deleteClip(clipId: string) {
    return userStore.deleteClip(clipId)
  }

  async getFolders() {
    return userStore.getFolders()
  }

  async createFolder(folder: Partial<ChatFolderRow>) {
    return userStore.createFolder(folder)
  }

  async updateFolder(folderId: string, updates: Partial<ChatFolderRow>) {
    return userStore.updateFolder(folderId, updates)
  }

  async deleteFolder(folderId: string, options: { deleteSessions?: boolean } = {}) {
    return userStore.deleteFolder(folderId, options)
  }
}

// Export singleton instance
export const databaseService = new DatabaseService()
