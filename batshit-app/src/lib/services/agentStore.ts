// Agent store operations for Redis
// Handles agent and subagent management

import { RedisStoreBase } from './redisCore'
import type { AgentRow, SubagentRow } from '$lib/types/database'
import { INSTRUCTIONS_REVISION_HEADER, captureInstructionsBaseline, type InstructionsBaseline, type InstructionsRevisions } from '$lib/appActions/settings/instructionsBaseline'

type InstructionsRequest = { expectedInstructions?: Partial<InstructionsRevisions> }

export class AgentStore extends RedisStoreBase {
  /** The original atomic detail body/header pair; list copies never supply a save base. */
  async getInstructionsBaseline(kind: InstructionsBaseline['kind'], id: string) {
    let header: string | null = null
    const fetcher = this.fetcher ?? fetch
    const payload = await this.apiCall(`/${kind === 'agent' ? 'agents' : 'subagents'}/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetcher(input, init)
        header = response.headers.get(INSTRUCTIONS_REVISION_HEADER)
        return response
      }
    } as RequestInit)
    const record = kind === 'agent' ? payload : payload?.subagent
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== id) throw new Error('The instructions response did not contain the requested record')
    return { record: record as AgentRow | SubagentRow, baseline: captureInstructionsBaseline(kind, record, header) }
  }
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

  async updateAgent(id: string, updates: Partial<AgentRow> & InstructionsRequest) {
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

  async updateSubagent(id: string, updates: Partial<SubagentRow> & InstructionsRequest) {
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
