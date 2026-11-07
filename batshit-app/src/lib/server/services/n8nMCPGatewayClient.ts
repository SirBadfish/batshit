import { readP5McpHttpAdmission, requireP5McpToolUse, revalidateP5McpHttpAdmission, validateP5McpHttpTool, notifyP5McpClientSettlement, settleBeforeAbort, type P5McpClientAdmission } from './mcpGatewayAdmission'
/**
 * n8n MCP Gateway Client
 *
 * Connects to n8n MCP Server Trigger workflows for gateway discovery.
 * Uses HTTP Streamable transport (production-ready, n8n compatible).
 *
 * ⚠️ CRITICAL MCP CLIENT LIFECYCLE PATTERN (TECH-002):
 * - ALWAYS use try/finally around createMCPClient
 * - ALWAYS await mcpClient.close() in finally block
 * - NEVER cache MCP clients (fresh per discovery)
 * - Use StreamableHTTPClientTransport for HTTP endpoints
 *
 * Risk Profile: TECH-002 (High) - Connection leaks will exhaust resources
 * Test Coverage: P0 tests verify proper cleanup on success and error
 */

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from 'ai'
import type { ToolWithName } from './mcpGatewayTypes'
import { logger } from '$lib/utils/logger'

export interface N8nMCPGatewayHealth {
  available: boolean
  error?: string
  toolCount?: number
}

type HeldHttpState = {
  creation?: Promise<MCPClient>; client?: MCPClient; transport?: StreamableHTTPClientTransport;
  initialize: 'pending' | 'known' | 'unknown'; constructor: 'started'; requests: Set<Promise<Response>>; requestIssued: boolean; requestUnknown: boolean; list: 'not_started' | 'pending' | 'known' | 'unknown';
  execute: 'not_started' | 'pending' | 'known' | 'unknown'; close: 'not_started' | 'pending' | 'known' | 'unknown';
  closing?: Promise<void>; closeRequested: boolean; removeAbort?: () => void; tools?: Record<string, Tool>
}

export class N8nMCPGatewayClient {
  private readonly heldHttp = new WeakMap<object, HeldHttpState>()

  /** One constructor implementation for ordinary and fixed original-owned HTTP calls. */
  private createHttpClient(url: URL, requestInit?: RequestInit, admission?: P5McpClientAdmission) {
    if (admission) readP5McpHttpAdmission(admission) // last synchronous issue fence
    const actualFetch = globalThis.fetch
    const heldFetch: typeof fetch | undefined = admission ? async (input, init) => {
      const state = this.heldHttp.get(admission)!
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (method === 'POST') {
        if (state.closeRequested) throw new Error('The actual held MCP client has closed issuance.')
        // The actual SDK has already awaited transport/header work. No awaited
        // authority read follows this joined cut before the SAME outbound call.
        await revalidateP5McpHttpAdmission(admission)
        readP5McpHttpAdmission(admission)
        if (state.closeRequested) throw new Error('The actual held MCP client has closed issuance.')
      }
      // GET/resumption already belongs to the actual transport's result drain;
      // ended positive authority cannot suppress its observation/close.
      state.requestIssued = true
      let physical: Promise<Response>
      try { physical = actualFetch(input, init) }
      catch (error) { state.requestUnknown = true; notifyP5McpClientSettlement(admission); throw error }
      state.requests.add(physical)
      try { return await physical }
      catch (error) { state.requestUnknown = true; throw error }
      finally { state.requests.delete(physical); notifyP5McpClientSettlement(admission) }
    } : undefined
    const transport = new StreamableHTTPClientTransport(url, { requestInit, ...(heldFetch ? { fetch: heldFetch } : {}) })
    if (admission) this.heldHttp.get(admission)!.transport = transport
    const creation = createMCPClient({ transport })
    return { transport, creation }
  }

  private async openForHeldApi(admission: P5McpClientAdmission): Promise<MCPClient> {
    let state = this.heldHttp.get(admission)
    if (!state) {
      // Refusal here is genuinely before constructor/physical initialization.
      await revalidateP5McpHttpAdmission(admission)
      const held = readP5McpHttpAdmission(admission)
      state = { initialize: 'pending', constructor: 'started', requests: new Set(), requestIssued: false, requestUnknown: false, list: 'not_started', execute: 'not_started', close: 'not_started', closeRequested: false }
      this.heldHttp.set(admission, state)
      const actual = state
      const abort = () => { void this.closeForHeldApi(admission) }
      held.signal.addEventListener('abort', abort, { once: true })
      actual.removeAbort = () => held.signal.removeEventListener('abort', abort)
      try {
        const created = this.createHttpClient(new URL(held.url), { headers: held.headers, signal: held.signal }, admission)
        actual.creation = created.creation.then(client => {
          actual.client = client; actual.initialize = 'known'; notifyP5McpClientSettlement(admission)
          // Late initialization is a physical fact, never a new effect grant.
          if (actual.closeRequested) void this.closeForHeldApi(admission)
          return client
        }, error => { actual.initialize = 'unknown'; notifyP5McpClientSettlement(admission); void this.closeForHeldApi(admission); throw error })
      } catch (error) { actual.initialize = 'unknown'; notifyP5McpClientSettlement(admission); void this.closeForHeldApi(admission); throw error }
    }
    const held = readP5McpHttpAdmission(admission)
    held.signal.throwIfAborted()
    if (!state.creation || state.closeRequested) throw new Error('The actual MCP initialization has ended; no new client was created.')
    const client = await settleBeforeAbort(state.creation, held.signal, () => { void this.closeForHeldApi(admission) })
    readP5McpHttpAdmission(admission)
    return client
  }

  /** Actual initialize/list for a held source. Setup uses its separate admission factory. */
  async listForHeldApi(admission: P5McpClientAdmission): Promise<Record<string, Tool>> {
    const client = await this.openForHeldApi(admission)
    await revalidateP5McpHttpAdmission(admission)
    readP5McpHttpAdmission(admission)
    const state = this.heldHttp.get(admission)!
    state.list = 'pending'
    const held = readP5McpHttpAdmission(admission)
    let issued: ReturnType<MCPClient['tools']>
    try { issued = client.tools() }
    catch (error) { state.list = 'unknown'; notifyP5McpClientSettlement(admission); throw error }
    const physical = issued.then(tools => {
      state.list = 'known'; state.tools = tools; notifyP5McpClientSettlement(admission); return tools
    }, error => { state.list = 'unknown'; notifyP5McpClientSettlement(admission); throw error })
    return settleBeforeAbort(physical, held.signal, () => { void this.closeForHeldApi(admission) })
  }

  async executeForHeldApi(admission: P5McpClientAdmission): Promise<unknown> {
    requireP5McpToolUse(admission)
    try {
      const tools = await this.listForHeldApi(admission)
      const held = readP5McpHttpAdmission(admission)
      if (!held.toolName) throw new Error('The actual tool identity is unavailable.')
      const target = tools[held.toolName]
      if (!target || typeof target.execute !== 'function') throw new Error('The held MCP tool is unavailable in the actual client.')
      const args = await validateP5McpHttpTool(admission, held.toolName, target)
      readP5McpHttpAdmission(admission)
      const state = this.heldHttp.get(admission)!
      state.execute = 'pending'
      // Only the actual promise may settle this physical fact; logical Stop is separate.
      let issued: unknown
      try { issued = Reflect.apply(target.execute, target, [args, { abortSignal: held.signal }]) }
      catch (error) { state.execute = 'unknown'; notifyP5McpClientSettlement(admission); throw error }
      const physical = Promise.resolve(issued).then(result => {
        state.execute = 'known'; notifyP5McpClientSettlement(admission); return result
      }, error => { state.execute = 'unknown'; notifyP5McpClientSettlement(admission); throw error })
      return await settleBeforeAbort(physical, held.signal, () => { void this.closeForHeldApi(admission) })
    } finally { void this.closeForHeldApi(admission) }
  }

  /** SAME actual close flight; no authority check may suppress late cleanup. */
  closeForHeldApi(admission: P5McpClientAdmission): Promise<void> {
    const state = this.heldHttp.get(admission)
    if (!state) { notifyP5McpClientSettlement(admission); return Promise.resolve() } // no physical issue was observed
    state.closeRequested = true
    state.closing ??= (async () => {
      state.close = 'pending'
      try {
        // Close an initializing transport now, then settle/close its late client.
        // This does not make initialization/list/effect uncertainty known.
        if (!state.client) await state.transport?.close()
        const client = state.client ?? await state.creation?.catch(() => undefined)
        if (client) await client.close()
        state.close = 'known'
        const unissued = !state.requestIssued && state.requests.size === 0
        const settled = state.requests.size === 0 && !state.requestUnknown && state.initialize === 'known' &&
          !['pending','unknown'].includes(state.list) && !['pending','unknown'].includes(state.execute)
        if (unissued || settled) { state.client = undefined; state.transport = undefined; state.creation = undefined; state.tools = undefined }
      } catch (error) { state.close = 'unknown'; logger.error('[MCP Gateway] Held original client close is unconfirmed') }
      finally { state.removeAbort?.(); notifyP5McpClientSettlement(admission) }
    })()
    return state.closing
  }

  /** Read only THIS actual owner facts, including after Stop. No mark-ready API. */
  readHeldApiSettlement(admission: P5McpClientAdmission) {
    const state = this.heldHttp.get(admission)
    if (!state) return Object.freeze({ constructor: 'not_started' as const, requests: 'not_started' as const, initialize: 'not_started' as const, list: 'not_started' as const, execute: 'not_started' as const, close: 'not_started' as const })
    return Object.freeze({ constructor: state.constructor, requests: state.requests.size ? 'pending' as const : state.requestUnknown ? 'unknown' as const : state.requestIssued ? 'known' as const : 'not_started' as const, initialize: state.initialize, list: state.list, execute: state.execute, close: state.close })
  }

  /**
   * Discover tools from n8n MCP Trigger gateway
   *
   * ✅ CORRECT MCP Client Lifecycle Pattern:
   * - Fresh client created per discovery (no caching)
   * - try/finally ensures cleanup happens
   * - await client.close() in finally block
   * - Cleanup happens even on error
   *
   * @param gatewayUrl - n8n MCP Trigger URL (e.g., http://localhost:5678/mcp/code-tools)
   * @returns Array of tool definitions
   */
  async discoverTools(
    gatewayUrl: string,
    options?: { headers?: Record<string, string>; timeoutMs?: number }
  ): Promise<ToolWithName[]> {
    let mcpClient: MCPClient | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const timeoutMs = options?.timeoutMs ?? 10_000

      logger.debug(`[MCP Gateway] Discovering tools from ${gatewayUrl}`)

      // Parse and validate URL
      const url = new URL(gatewayUrl)

      const controller = new AbortController()
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort()
          reject(new Error(`Tool discovery timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })

      const requestInit: RequestInit | undefined =
        controller.signal || options?.headers
          ? {
              signal: controller.signal,
              ...(options?.headers ? { headers: options.headers } : {})
            }
          : undefined

      // Create HTTP Streamable transport (production-ready)
      // Note: Don't specify sessionId - let the transport handle session management.
      const { creation } = this.createHttpClient(url, requestInit)

      // Create fresh MCP client for this discovery; ordinary timeout/output unchanged.
      mcpClient = (await Promise.race([creation, timeoutPromise])) as MCPClient

      // Discover tools from the n8n MCP workflow
      const tools = await Promise.race([mcpClient.tools(), timeoutPromise])

      logger.debug(`[MCP Gateway] Discovered ${Object.keys(tools).length} tools from ${gatewayUrl}`)

      // Convert tools object to array with names attached (Story 5.23)
      // Tools come as { toolName: CoreTool }, we need to preserve the names
      const entries = Object.entries(tools as Record<string, Tool>)
      return entries.map(([name, tool]) => ({
        ...tool,
        name // Attach the tool name as a property
      })) as ToolWithName[]
    } catch (error) {
      console.error(`[MCP Gateway] Failed to discover tools from ${gatewayUrl}:`, error)
      throw new Error(`Failed to discover tools: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      if (timeoutId) clearTimeout(timeoutId)

      // ✅ MANDATORY: Always close the client, even on error
      // ⚠️ CRITICAL: Must await the close() call!
      if (mcpClient) {
        try {
          await Promise.race([
            mcpClient.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 250))
          ])
          logger.debug(`[MCP Gateway] Closed MCP client for ${gatewayUrl}`)
        } catch (closeError) {
          console.error(`[MCP Gateway] Error closing client for ${gatewayUrl}:`, closeError)
        }
      }
    }
  }

  /**
   * Health check for n8n MCP gateway
   *
   * ✅ CORRECT Pattern: Same try/finally pattern as discoverTools
   *
   * @param gatewayUrl - n8n MCP Trigger URL
   * @param timeoutMs - Connection timeout in milliseconds
   * @returns Health status with tool count
   */
  async healthCheck(gatewayUrl: string, timeoutMs: number = 5000, options?: { headers?: Record<string, string> }): Promise<N8nMCPGatewayHealth> {
    let mcpClient: MCPClient | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      // Parse URL
      const url = new URL(gatewayUrl)

      // Create AbortController for timeout
      const controller = new AbortController()
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort()
          reject(new Error(`Health check timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })

      try {
        const requestInit: RequestInit = {
          signal: controller.signal,
          ...(options?.headers ? { headers: options.headers } : {})
        }

        // Create transport with timeout
        // Note: Don't specify sessionId - let the transport handle session management.
        const { creation } = this.createHttpClient(url, requestInit)

        // Fresh client for health check; ordinary timeout/output unchanged.
        mcpClient = (await Promise.race([
          creation,
          timeoutPromise
        ])) as MCPClient

        // Try to get tools (proves gateway is responding)
        const tools = await Promise.race([mcpClient.tools(), timeoutPromise])
        const toolCount = Object.keys(tools).length

        return {
          available: true,
          toolCount
        }
      } catch (err) {
        throw err
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Connection failed'
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)

      // ✅ MANDATORY: Always close, even on health check
      if (mcpClient) {
        try {
          await Promise.race([
            mcpClient.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 250))
          ])
        } catch (closeError) {
          console.error('[MCP Gateway] Error closing health check client:', closeError)
        }
      }
    }
  }

  /**
   * Validate gateway URL format
   */
  validateGatewayUrl(url: string): { valid: boolean; error?: string } {
    try {
      const parsedUrl = new URL(url)

      // Must be HTTP or HTTPS
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return {
          valid: false,
          error: 'Gateway URL must use http:// or https:// protocol'
        }
      }

      // Must have a path (MCP endpoint)
      if (parsedUrl.pathname === '' || parsedUrl.pathname === '/') {
        return {
          valid: false,
          error: 'Gateway URL must include MCP endpoint path (e.g., /mcp/code-tools)'
        }
      }

      return { valid: true }
    } catch {
      return {
        valid: false,
        error: 'Invalid URL format'
      }
    }
  }
}

// Export singleton instance
export const n8nMCPGatewayClient = new N8nMCPGatewayClient()
