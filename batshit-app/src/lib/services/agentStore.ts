// Agent store operations for Redis
// Handles agent and subagent management

import { RedisStoreBase } from './redisCore'
import type { AgentRow, SubagentRow } from '$lib/types/database'

export class AgentStore extends RedisStoreBase {
  // Agents
  async getAgents(userId: string) {
    const agents = await this.apiCall(`/agents`)
    return agents.agents as AgentRow[]
  }

  async createAgent(agent: Partial<AgentRow>) {
    const response = await this.apiCall('/agents', {
      method: 'POST',
      body: JSON.stringify(agent)
    })

    return response as AgentRow
  }

  async updateAgent(id: string, updates: Partial<AgentRow>) {
    await this.apiCall(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
  }

  async deleteAgent(id: string) {
    await this.apiCall(`/agents/${id}`, {
      method: 'DELETE'
    })
  }

  // Subagents
  async getSubagents(userId: string) {
    const response = await this.apiCall('/subagents')
    return response.subagents as SubagentRow[]
  }

  async createSubagent(subagent: Partial<SubagentRow>) {
    const response = await this.apiCall('/subagents', {
      method: 'POST',
      body: JSON.stringify(subagent)
    })

    return response.subagent as SubagentRow
  }

  async updateSubagent(id: string, updates: Partial<SubagentRow>) {
    const response = await this.apiCall(`/subagents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })

    return response.subagent as SubagentRow
  }

  async deleteSubagent(id: string) {
    await this.apiCall(`/subagents/${id}`, {
      method: 'DELETE'
    })
  }
}

export const agentStore = new AgentStore()
