/**
 * Workflow Discovery Service for API Primary Agents
 * Story 5.11: Discovers n8n workflows with webhook triggers
 *
 * CRITICAL: Never expose webhook URLs in logs (SEC-001)
 * CRITICAL: Direct object storage in Redis (no stringify/parse)
 * CRITICAL: Use SvelteKit env system, not process.env
 */

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { logger } from '$lib/utils/logger'
import type { RedisJSON } from '@redis/json'
import type { MCPGateway } from '$lib/types/database'

interface DirectMCPDiscoveryOptions {
  excludeServerUrls?: string[]
  excludeWorkflowIds?: string[]
  excludeWorkflowNames?: string[]
  excludeWebhookUrls?: string[]
  excludeServerNames?: string[]
  excludeWebhookPaths?: string[]
}

/**
 * Workflow information from n8n API
 */
export interface WorkflowInfo {
  id: string
  name: string
  description?: string
  active: boolean
  webhookUrl?: string
  nodes?: any[]
  tags?: string[]
  updatedAt?: string
  connections?: Record<string, any>
}

/**
 * Cached workflow discovery data
 */
interface WorkflowCache {
  workflows: WorkflowInfo[]
  timestamp: number
}

/**
 * Workflow Discovery Service
 * Discovers and caches available workflows from n8n
 */
export class WorkflowDiscovery {
  private readonly cacheKey = 'workflow_discovery_cache'
  private readonly cacheTTL = 60000 // 1 minute TTL (OPS-001)
  private readonly mcpClientNodeTypes = [
    '@n8n/n8n-nodes-langchain.mcpClientTool',
    'n8n-nodes-langchain.mcpClientTool',
    '@n8n/n8n-nodes-mcp.mcpClient',
    'n8n-nodes-mcp.mcpClient'
  ]

  /**
   * Get available workflows with webhook triggers
   * Uses caching to minimize n8n API calls
   */
  async getAvailableWorkflows(force = false): Promise<WorkflowInfo[]> {
    logger.debug('[WorkflowDiscovery] Getting available workflows', { force })

    if (!force) {
      const cached = await this.getCachedWorkflows()
      if (cached && cached.length > 0) {
        logger.debug('[WorkflowDiscovery] Returning cached workflows', {
          count: cached.length
        })
        return cached
      }
    }

    const workflows = await this.fetchWorkflowsFromN8n()
    const webhookWorkflows = this.filterWebhookWorkflows(workflows)
    await this.cacheWorkflows(webhookWorkflows)

    logger.debug('[WorkflowDiscovery] Discovered workflows', {
      total: workflows.length,
      withWebhooks: webhookWorkflows.length
    })

    return webhookWorkflows
  }

  /**
   * Get cached workflows if not expired
   * CRITICAL: Redis 8 pattern - no JSON.parse needed
   */
  private async getCachedWorkflows(): Promise<WorkflowInfo[] | null> {
    try {
      const cached = await redis.execute(async (client) => {
        return await client.json.get(this.cacheKey) as WorkflowCache | null
      })

      if (!cached) {
        return null
      }

      if (Date.now() - cached.timestamp > this.cacheTTL) {
        logger.debug('[WorkflowDiscovery] Cache expired')
        return null
      }

      return cached.workflows
    } catch (error) {
      console.error('[WorkflowDiscovery] Cache read error:', error)
      return null
    }
  }

  /**
   * Cache workflow discovery data
   * CRITICAL: Redis 8 pattern - no JSON.stringify needed
   */
  private async cacheWorkflows(workflows: WorkflowInfo[]): Promise<void> {
    try {
      const cacheData: WorkflowCache = {
        workflows,
        timestamp: Date.now()
      }

      await redis.execute(async (client) => {
        await client.json.set(this.cacheKey, '$', cacheData as unknown as RedisJSON)
        await client.expire(this.cacheKey, Math.ceil(this.cacheTTL / 1000))
      })

      logger.debug('[WorkflowDiscovery] Cached workflows', {
        count: workflows.length
      })
    } catch (error) {
      console.error('[WorkflowDiscovery] Cache write error:', error)
      // Non-critical error, continue without caching
    }
  }

  /**
   * Fetch workflows from n8n API
   * CRITICAL: Include authentication headers (SEC-001)
   */
  private async fetchWorkflowsFromN8n(): Promise<WorkflowInfo[]> {
    const n8nApiUrl = env.N8N_API_URL || 'http://localhost:5678'
    const n8nHeaderValue = env.N8N_API_KEY

    if (!n8nHeaderValue) {
      logger.debug('[WorkflowDiscovery] N8N_API_KEY not configured, using empty workflow list')
      return []
    }

    try {
      const response = await fetch(`${n8nApiUrl}/api/v1/workflows`, {
        method: 'GET',
        headers: {
          'X-N8N-API-KEY': n8nHeaderValue,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      })

      if (!response.ok) {
        console.error('[WorkflowDiscovery] n8n API error', {
          status: response.status
        })
        throw new Error(`n8n workflow discovery failed with status ${response.status}`)
      }

      const data = await response.json()

      // Handle n8n API response format
      const workflows = Array.isArray(data) ? data : data.data || []

      return workflows.map(this.normalizeWorkflow)
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.error('[WorkflowDiscovery] n8n API timeout')
        throw new Error('n8n workflow discovery timed out')
      } else {
        console.error('[WorkflowDiscovery] n8n API fetch error:', error.message)
        throw error
      }
    }
  }

  /**
   * Filter workflows that have webhook triggers
   */
  private filterWebhookWorkflows(workflows: WorkflowInfo[]): WorkflowInfo[] {
    return workflows.filter(workflow => {
      // Only include active workflows
      if (!workflow.active) {
        return false
      }

      // Check if workflow has webhook nodes
      if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
        return false
      }

      // Look for webhook trigger nodes
      const hasWebhook = workflow.nodes.some(node =>
        node.type === 'n8n-nodes-base.webhook' ||
        node.type === '@n8n/n8n-nodes-base.webhook' ||
        node.type?.includes('webhook')
      )

      return hasWebhook
    })
  }

  /**
   * Normalize workflow data from n8n API
   */
  private normalizeWorkflow(workflow: any): WorkflowInfo {
    // Extract webhook URL if available
    let webhookUrl: string | undefined

    if (workflow.nodes && Array.isArray(workflow.nodes)) {
      const webhookNode = workflow.nodes.find((n: any) =>
        n.type?.includes('webhook')
      )

      if (webhookNode?.parameters?.path) {
        // Build webhook URL from path
        const baseUrl = env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook'
        webhookUrl = `${baseUrl}/${webhookNode.parameters.path}`
      }
    }

    return {
      id: workflow.id,
      name: workflow.name || `Workflow ${workflow.id}`,
      description: workflow.description,
      active: workflow.active !== false,
      webhookUrl,
      nodes: workflow.nodes,
      connections: workflow.connections,
      tags: workflow.tags,
      updatedAt: workflow.updatedAt
    }
  }

  private isMcpClientNode(node: any): boolean {
    if (!node || typeof node !== 'object') {
      return false
    }

    const type = String(node.type || '')
    if (!type) {
      return false
    }

    if (this.mcpClientNodeTypes.includes(type)) {
      return true
    }

    return type.toLowerCase().includes('mcpclient')
  }

  private sanitizeIdentifier(name: string | undefined): string {
    if (!name) return 'mcp'
    return name
      .toString()
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'mcp'
  }

  private extractMcpToolNames(node: any): string[] {
    const parameters = node?.parameters ?? {}
    const rawNames: string[] = []

    const arrayFields = ['tools', 'toolNames', 'selectedTools', 'toolIds']
    for (const field of arrayFields) {
      const value = parameters[field]
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string') {
            rawNames.push(entry)
          } else if (entry && typeof entry === 'object') {
            if (typeof entry.name === 'string') {
              rawNames.push(entry.name)
            }
            if (typeof entry.id === 'string') {
              rawNames.push(entry.id)
            }
          }
        }
      }
    }

    const singleFields = ['tool', 'toolName', 'mcpTool', 'selectedTool']
    for (const field of singleFields) {
      const value = parameters[field]
      if (typeof value === 'string') {
        rawNames.push(value)
      }
    }

    if (rawNames.length === 0 && typeof node?.name === 'string') {
      rawNames.push(node.name)
    }

    const unique = Array.from(
      new Set(
        rawNames
          .map((name) => (typeof name === 'string' ? name.trim() : ''))
          .filter((name) => name.length > 0)
      )
    )

    if (unique.length === 0) {
      return ['mcp_tool']
    }

    return unique.map((name) => this.sanitizeIdentifier(name))
  }

  private extractMcpServerName(node: any, fallback: string): string {
    const parameters = node?.parameters ?? {}
    const candidates: Array<string | undefined> = [
      parameters.serverName,
      parameters.server,
      parameters.mcpServerName,
      parameters.mcpServer,
      parameters.connectionName,
      parameters.clientName,
      node?.name,
      typeof node?.id === 'string' ? node.id : undefined
    ]

    if (node?.credentials && typeof node.credentials === 'object') {
      for (const value of Object.values(node.credentials)) {
        if (value && typeof value === 'object') {
          if (typeof (value as any).name === 'string') {
            candidates.push((value as any).name)
          }
          if (typeof (value as any).displayName === 'string') {
            candidates.push((value as any).displayName)
          }
        }
      }
    }

    const resolved = candidates.find((value) => typeof value === 'string' && value.trim().length > 0)
    return resolved ? String(resolved) : fallback
  }

  private extractMcpServerUrl(node: any): string | undefined {
    const parameters = node?.parameters ?? {}
    const candidates: Array<string | undefined> = [
      parameters.mcpServerUrl,
      parameters.serverUrl,
      parameters.url,
      parameters.endpointUrl,
      parameters.endpointURL,
      parameters.endpoint,
      parameters.connectionUrl,
      parameters.webhookUrl
    ]

    const direct = candidates.find((value) => typeof value === 'string' && value.trim().length > 0)
    if (direct) {
      return direct
    }

    if (node?.credentials && typeof node.credentials === 'object') {
      for (const value of Object.values(node.credentials)) {
        if (value && typeof value === 'object') {
          const credential = value as any
          if (credential?.data && typeof credential.data === 'object') {
            const credentialUrl = credential.data.url || credential.data.endpoint
            if (typeof credentialUrl === 'string' && credentialUrl.trim().length > 0) {
              return credentialUrl
            }
          }
        }
      }
    }

    return undefined
  }

  private workflowMatchesFilters(workflow: WorkflowInfo, filters?: string[]): boolean {
    if (!filters || filters.length === 0) {
      return true
    }

    const normalized = filters.map((filter) => filter.toLowerCase())
    const candidates = [
      workflow.id,
      workflow.name,
      workflow.webhookUrl,
      ...(Array.isArray(workflow.nodes)
        ? workflow.nodes
            .map((node: any) => node?.id || node?.name)
            .filter((value): value is string => typeof value === 'string')
        : [])
    ]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase())

    for (const filter of normalized) {
      if (candidates.some((candidate) => candidate === filter || candidate.includes(filter))) {
        return true
      }
    }

    return false
  }

  private normalizeUrl(url?: string): string | undefined {
    if (!url || typeof url !== 'string') {
      return undefined
    }

    try {
      const parsed = new URL(url)
      const pathname = parsed.pathname.replace(/\/+$/, '')
      return `${parsed.protocol}//${parsed.host}${pathname}`.toLowerCase()
    } catch {
      return url.trim().replace(/\/+$/, '').toLowerCase() || undefined
    }
  }

  private normalizeWebhookPath(url?: string): string | undefined {
    if (!url || typeof url !== 'string') {
      return undefined
    }

    try {
      const parsed = new URL(url)
      let path = parsed.pathname.replace(/\/+$/, '')
      path = path.replace(/^\/+/, '')
      if (!path) return undefined
      if (path.startsWith('webhook/')) {
        path = path.slice('webhook/'.length)
      }
      return path.toLowerCase()
    } catch {
      let trimmed = url.trim().replace(/^https?:\/\//, '')
      trimmed = trimmed.replace(/\/+$/, '')
      trimmed = trimmed.replace(/^\/+/, '')
      if (trimmed.startsWith('webhook/')) {
        trimmed = trimmed.slice('webhook/'.length)
      }
      return trimmed ? trimmed.toLowerCase() : undefined
    }
  }

  /**
   * Get workflow by ID
   */
  async getWorkflowById(workflowId: string): Promise<WorkflowInfo | null> {
    // First check cache
    const workflows = await this.getAvailableWorkflows()
    const cached = workflows.find(w => w.id === workflowId)

    if (cached) {
      return cached
    }

    // If not in cache, fetch directly
    return await this.fetchWorkflowById(workflowId)
  }

  async discoverDirectMCPClients(
    userId: string,
    filters?: string[],
    options?: DirectMCPDiscoveryOptions
  ): Promise<MCPGateway[]> {
    try {
      const workflows = await this.getAvailableWorkflows()
      const relevant = workflows.filter((workflow) => this.workflowMatchesFilters(workflow, filters))

      const excludedServerUrlsRaw = new Set(
        (options?.excludeServerUrls ?? [])
          .map((url) => (typeof url === 'string' ? url.trim() : ''))
          .filter((value): value is string => Boolean(value))
      )

      const excludedServerUrls = new Set(
        Array.from(excludedServerUrlsRaw)
          .map((url) => this.normalizeUrl(url))
          .filter((value): value is string => Boolean(value))
      )

      const excludedWorkflowIds = new Set(
        (options?.excludeWorkflowIds ?? [])
          .map((id) => {
            if (!id) return undefined
            return String(id).toLowerCase()
          })
          .filter((value): value is string => Boolean(value))
      )

      const excludedWorkflowNames = new Set(
        (options?.excludeWorkflowNames ?? [])
          .map((name) => (name ? name.toLowerCase() : undefined))
          .filter((value): value is string => Boolean(value))
      )

      const excludedWebhookUrlsRaw = new Set(
        (options?.excludeWebhookUrls ?? [])
          .map((url) => (typeof url === 'string' ? url.trim() : ''))
          .filter((value): value is string => Boolean(value))
      )

      const excludedWebhookUrls = new Set(
        Array.from(excludedWebhookUrlsRaw)
          .map((url) => this.normalizeUrl(url))
          .filter((value): value is string => Boolean(value))
      )

      const excludedServerNames = new Set(
        (options?.excludeServerNames ?? [])
          .map((name) => (name ? name.toLowerCase() : undefined))
          .filter((value): value is string => Boolean(value))
      )

      const excludedWebhookPaths = new Set(
        (options?.excludeWebhookPaths ?? [])
          .map((path: string) => (path ? path.toLowerCase() : undefined))
          .filter((value): value is string => Boolean(value))
      )

      const syntheticGateways: MCPGateway[] = []

      for (const workflow of relevant) {
        const workflowLabel = workflow.name || workflow.id || 'Workflow'
        const sanitizedWorkflow = this.sanitizeIdentifier(workflowLabel)

        const workflowIdNormalized = workflow.id ? workflow.id.toLowerCase() : undefined
        const workflowNameNormalized = workflow.name ? workflow.name.toLowerCase() : undefined
        const workflowWebhookNormalized = this.normalizeUrl(workflow.webhookUrl)
        const workflowWebhookPath = this.normalizeWebhookPath(workflow.webhookUrl)

        if (
          (workflowIdNormalized && excludedWorkflowIds.has(workflowIdNormalized)) ||
          (workflowNameNormalized && excludedWorkflowNames.has(workflowNameNormalized)) ||
          (workflowWebhookNormalized && excludedWebhookUrls.has(workflowWebhookNormalized)) ||
          (workflowWebhookPath && excludedWebhookPaths.has(workflowWebhookPath))
        ) {
          continue
        }

        const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
        for (const node of nodes) {
          if (!this.isMcpClientNode(node)) {
            continue
          }

          const toolNames = this.extractMcpToolNames(node)
          logger.debug('[WorkflowDiscovery] Inspecting MCP client node', {
            workflowId: workflow.id,
            workflowName: workflow.name,
            workflowWebhook: workflow.webhookUrl,
            nodeId: node?.id,
            nodeName: node?.name,
            nodeType: node?.type,
            parameters: node?.parameters,
            credentials: node?.credentials,
            toolNames,
          connections: workflow?.connections?.[node?.name] || workflow?.connections?.[node?.id]
          })
          if (toolNames.length === 0) {
            continue
          }

          const serverName = this.extractMcpServerName(node, 'n8n MCP Client')
          const sanitizedNode = this.sanitizeIdentifier(node?.name || node?.id || serverName)
          const gatewayId = `n8n-mcp-client:${sanitizedWorkflow}:${sanitizedNode}`
          const serverUrl = this.extractMcpServerUrl(node)

          const connections = workflow?.connections?.[node?.name] || workflow?.connections?.[node?.id]
          const aiToolTargetsRaw = Array.isArray(connections?.ai_tool) ? connections.ai_tool : []
          const aiToolTargets: any[] = []
          for (const group of aiToolTargetsRaw) {
            if (Array.isArray(group)) {
              for (const target of group) {
                if (target) aiToolTargets.push(target)
              }
            } else if (group) {
              aiToolTargets.push(group)
            }
          }

          let hasAiAgentToolConnection = false
          const evaluatedTargets: Array<{ targetId: string | null; targetType: string | null; raw: any }> = []

          if (aiToolTargets.length > 0 && Array.isArray(workflow.nodes)) {
            for (const target of aiToolTargets) {
              const targetId = target?.node || target?.id || target?.name || null
              let targetType: string | null = null
              if (targetId) {
                const targetNode = workflow.nodes.find((candidate: any) =>
                  candidate?.id === targetId || candidate?.name === targetId
                )
                if (targetNode?.type) {
                  targetType = String(targetNode.type).toLowerCase()
                  if (
                    targetType.includes('aiagenttool') ||
                    targetType.includes('aiagent-tool') ||
                    targetType.includes('agenttool')
                  ) {
                    hasAiAgentToolConnection = true
                  }
                }
              }
              evaluatedTargets.push({ targetId, targetType, raw: target })
              if (hasAiAgentToolConnection) {
                break
              }
            }
          }

          if (aiToolTargets.length > 0) {
          logger.debug('[WorkflowDiscovery] ai_tool evaluation', {
            workflowId: workflow.id,
            nodeId: node?.id,
            nodeName: node?.name,
            evaluatedTargets,
            hasAiAgentToolConnection
            })
          }

          if (hasAiAgentToolConnection) {
            logger.debug('[WorkflowDiscovery] Skipping MCP client due to aiAgentTool connection', {
              workflowId: workflow.id,
              nodeId: node?.id,
              nodeName: node?.name,
              evaluatedTargets
            })
            continue
          }

          const serverNameNormalized = serverName ? serverName.toLowerCase() : undefined
          const excludedByName = serverNameNormalized ? excludedServerNames.has(serverNameNormalized) : false
          if (excludedByName) {
            logger.debug('[WorkflowDiscovery] Skipping MCP client due to server name', {
              workflowId: workflow.id,
              nodeId: node?.id,
              serverNameNormalized,
              excludedServerNames: Array.from(excludedServerNames)
            })
            continue
          }

          const normalizedServerUrl = this.normalizeUrl(serverUrl)
          const excludedByUrl = normalizedServerUrl ? excludedServerUrls.has(normalizedServerUrl) : false
          const excludedByRawUrl = serverUrl ? excludedServerUrlsRaw.has(serverUrl.trim()) : false
          const excludedByWebhookUrl = normalizedServerUrl ? excludedWebhookUrls.has(normalizedServerUrl) : false
          const excludedByRawWebhookUrl = serverUrl ? excludedWebhookUrlsRaw.has(serverUrl.trim()) : false
          logger.debug('[WorkflowDiscovery] MCP client normalized URL check', {
            workflowId: workflow.id,
            nodeId: node?.id,
            normalizedServerUrl,
            excludedByUrl,
            excludedByRawUrl,
            excludedByWebhookUrl,
            excludedByRawWebhookUrl,
            excludedServerUrls: Array.from(excludedServerUrls),
            excludedServerUrlsRaw: Array.from(excludedServerUrlsRaw),
            excludedWebhookUrls: Array.from(excludedWebhookUrls),
            excludedWebhookUrlsRaw: Array.from(excludedWebhookUrlsRaw)
          })
          if (excludedByUrl || excludedByWebhookUrl || excludedByRawUrl || excludedByRawWebhookUrl) {
            continue
          }

          const existing = syntheticGateways.find((gateway) => gateway.id === gatewayId)
          if (existing) {
            const additional = toolNames.filter((tool) => !existing.discoveredTools?.includes(tool))
            if (additional.length > 0) {
              existing.discoveredTools = [...(existing.discoveredTools || []), ...additional]
              if (existing.metadata) {
                existing.metadata.toolNames = existing.discoveredTools
              }
            }
            continue
          }

          syntheticGateways.push({
            id: gatewayId,
            name: `${workflowLabel} • ${serverName}`,
            type: 'n8n-mcp-client',
            url: serverUrl || `n8n-mcp-client://${workflow.id ?? sanitizedWorkflow}/${node?.id ?? sanitizedNode}`,
            enabled: true,
            discoveredTools: toolNames,
            metadata: {
              workflowId: workflow.id,
              workflowName: workflow.name,
              workflowWebhook: workflow.webhookUrl,
              nodeId: node?.id,
              nodeName: node?.name,
              serverName,
              serverUrl,
              toolNames,
              rawParameters: node?.parameters ?? {},
              rawCredentials: node?.credentials ?? {},
              discoveredForUser: userId
            },
            created_at: workflow.updatedAt || new Date().toISOString(),
            updated_at: workflow.updatedAt
          })
        }
      }

      return syntheticGateways
    } catch (error) {
      console.error('[WorkflowDiscovery] Failed to discover direct MCP clients:', error)
      return []
    }
  }

  /**
   * Fetch specific workflow from n8n API
   */
  private async fetchWorkflowById(workflowId: string): Promise<WorkflowInfo | null> {
    const n8nApiUrl = env.N8N_API_URL || 'http://localhost:5678'
    const n8nHeaderValue = env.N8N_API_KEY

    if (!n8nHeaderValue) {
      logger.debug('[WorkflowDiscovery] N8N_API_KEY not configured')
      return null
    }

    try {
      const response = await fetch(`${n8nApiUrl}/api/v1/workflows/${workflowId}`, {
        method: 'GET',
        headers: {
          'X-N8N-API-KEY': n8nHeaderValue,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        if (response.status === 404) {
          logger.debug('[WorkflowDiscovery] Workflow not found', {
            id: workflowId
          })
        } else {
          console.error('[WorkflowDiscovery] n8n API error', {
            status: response.status
          })
        }
        return null
      }

      const workflow = await response.json()
      return this.normalizeWorkflow(workflow)
    } catch (error: any) {
      console.error('[WorkflowDiscovery] Fetch workflow error:', error.message)
      return null
    }
  }

  /**
   * Clear workflow cache
   * Used for manual refresh or testing
   */
  async clearCache(): Promise<void> {
    try {
      await redis.del(this.cacheKey)
      logger.debug('[WorkflowDiscovery] Cache cleared')
    } catch (error) {
      console.error('[WorkflowDiscovery] Clear cache error:', error)
    }
  }

  /**
   * Check workflow ownership/permissions
   * Batshit is single-user-per-instance, so workflow visibility is instance-wide.
   * The active-workflow check remains here to keep inactive n8n workflows from
   * becoming agent tools.
   */
  async checkWorkflowPermission(
    workflowId: string,
    userId: string
  ): Promise<boolean> {
    logger.debug('[WorkflowDiscovery] Permission check', {
      workflowId,
      userId: userId.substring(0, 8) + '...' // Log partial ID only
    })

    // Basic validation - workflow must exist and be active
    const workflow = await this.getWorkflowById(workflowId)

    if (!workflow || !workflow.active) {
      return false
    }

    return true
  }
}

// Export singleton instance
export const workflowDiscovery = new WorkflowDiscovery()
