// Slash command store operations for Redis
// Handles slash command CRUD

import { RedisStoreBase } from './redisCore'
import type { SlashCommandRow } from '$lib/types/database'
import { dispatchSlashCommandsUpdated } from '$lib/utils/liveSettingsEvents'

export class SlashCommandStore extends RedisStoreBase {
  async getSlashCommands(userId: string) {
    try {
      const response = await this.apiCall(`/slash-commands`)
      return response.slashCommands as SlashCommandRow[]
    } catch (error) {
      console.error('Failed to get slash commands:', error)
      return []
    }
  }

  async getSlashCommand(commandId: string) {
    try {
      const response = await this.apiCall(`/slash-commands/${commandId}`)
      return response.slashCommand as SlashCommandRow
    } catch (error) {
      console.error('Failed to get slash command:', error)
      return null
    }
  }

  async createSlashCommand(command: Partial<SlashCommandRow>) {
    const response = await this.apiCall('/slash-commands', {
      method: 'POST',
      body: JSON.stringify(command)
    })
    const slashCommand = response.slashCommand as SlashCommandRow
    dispatchSlashCommandsUpdated({ source: 'settings', commandId: slashCommand.id })
    return slashCommand
  }

  async updateSlashCommand(id: string, updates: Partial<SlashCommandRow>) {
    const response = await this.apiCall(`/slash-commands/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
    const slashCommand = response.slashCommand as SlashCommandRow
    dispatchSlashCommandsUpdated({
      source: Object.prototype.hasOwnProperty.call(updates, 'enabled_agent_ids')
        ? 'agent-access'
        : 'settings',
      commandId: slashCommand.id
    })
    return slashCommand
  }

  /**
   * BL-544: turn ONE agent or Subagent on or off for one Skill or Prompt (Settings > Agents >
   * Access). The server adds or removes that id against the list as stored now, so a list changed
   * elsewhere since this page loaded it is never replaced by this page's copy. Answers the command
   * as stored.
   */
  async setSlashCommandAgentAccess(id: string, agentId: string, enabled: boolean) {
    const response = await this.apiCall(`/slash-commands/${encodeURIComponent(id)}/agent-access`, {
      method: 'PUT',
      body: JSON.stringify({ agentId, enabled })
    })
    const slashCommand = response.slashCommand as SlashCommandRow
    dispatchSlashCommandsUpdated({ source: 'agent-access', commandId: slashCommand.id })
    return slashCommand
  }

  async deleteSlashCommand(id: string) {
    await this.apiCall(`/slash-commands/${id}`, {
      method: 'DELETE'
    })
    dispatchSlashCommandsUpdated({ source: 'settings', commandId: id })
  }

  async invokeSlashCommand(id: string, params?: Record<string, any>) {
    const response = await this.apiCall(`/slash-commands/${id}/invoke`, {
      method: 'POST',
      body: JSON.stringify({ params })
    })
    return response
  }
}

export const slashCommandStore = new SlashCommandStore()
