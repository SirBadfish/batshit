import type { P5McpClientAdmission } from './mcpGatewayAdmission'
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool } from 'ai'

import type { MCPGateway } from '$lib/types/database'
import type { ToolWithName } from './mcpGatewayTypes'
import {
  resolveStdioGatewayProcessConfig,
  type ResolvedStdioGatewayProcessConfig
} from './mcpGatewayStdio'
import { logger } from '$lib/utils/logger'

export interface StdioMCPGatewayHealth {
  available: boolean
  error?: string
  toolCount?: number
}

function buildErrorMessage(base: string, stderrChunks: string[]): string {
  const stderr = stderrChunks.join('').trim()
  if (!stderr) return base
  return `${base} (${stderr})`
}

/**
 * BL-602: a start that timed out (or failed) has no client to close, so nothing closed its
 * transport and the gateway's server process ran on. Closing the transport ends the process
 * (stdin end, SIGTERM 2 s later, SIGKILL 2 s after that: the MCP SDK's own close), and a
 * client that would have finished starting later finds its transport closed. The caller gets
 * its error at once; the close runs on behind it. A second close of the same transport, after
 * the client's own failed-start close, does nothing.
 */
function closeUnstartedTransport(transport: StdioClientTransport, gatewayName: string): void {
  void transport.close().catch((closeError: unknown) => {
    logger.warn(`[STDIO MCP] Could not close ${gatewayName} after a failed start`, closeError)
  })
}

type HeldStdioState = {
  creation?: Promise<MCPClient>; client?: MCPClient; transport?: StdioClientTransport;
  initialize: 'not_started' | 'pending' | 'known' | 'unknown'; constructor: 'not_started' | 'started'; requests: Set<Promise<unknown>>;
  requestIssued: boolean; requestUnknown: boolean; spawnIssued: boolean; childClosed: boolean;
  list: 'not_started' | 'pending' | 'known' | 'unknown'; execute: 'not_started' | 'pending' | 'known' | 'unknown';
  close: 'not_started' | 'pending' | 'known' | 'unknown'; closeRequested: boolean; closing?: Promise<void>; rawClosing?: Promise<void>;
  closed: Promise<void>; observeClose(): void; notify(): void; removeAbort?(): void
}
/** Restrictive preconstruction custody, not a known-close certificate. */
function unstartedHeldStdioState(): HeldStdioState {
  let observeClose: () => void = () => {}
  const closed = new Promise<void>(resolve => { observeClose = resolve })
  return { constructor: 'not_started', initialize: 'not_started', requests: new Set(), requestIssued: false, requestUnknown: false,
    spawnIssued: false, childClosed: false, list: 'not_started', execute: 'not_started', close: 'not_started', closeRequested: false,
    closed, observeClose, notify: () => {} }
}
export class StdioMCPGatewayClient {
  private readonly heldStdio = new WeakMap<object, HeldStdioState>()

  private observeRequest<T>(admission: P5McpClientAdmission, physical: Promise<T>): Promise<T> {
    const state = this.heldStdio.get(admission)!
    state.requestIssued = true; state.requests.add(physical)
    return physical.then(value => { state.requests.delete(physical); state.notify(); return value }, error => {
      state.requests.delete(physical); state.requestUnknown = true; state.notify(); throw error
    })
  }
  private async waitForHeld<T>(admission: P5McpClientAdmission, physical: Promise<T>, timeoutMs: number): Promise<T> {
    const owner = await import('./mcpGatewayAdmission')
    const held = owner.readP5McpStdioAdmission(admission)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      void this.closeForHeldApi(admission); reject(new Error('The held STDIO stage timed out; physical custody is retained.'))
    }, timeoutMs) })
    try { return await owner.settleBeforeAbort(Promise.race([physical, timeout]), held.signal, () => { void this.closeForHeldApi(admission) }) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }

  private async openForHeldApi(admission: P5McpClientAdmission): Promise<MCPClient> {
    const owner = await import('./mcpGatewayAdmission')
    let state = this.heldStdio.get(admission)
    if (!state) {
      await owner.revalidateP5McpHttpAdmission(admission)
      const held = owner.readP5McpStdioAdmission(admission), resolved = held.resolved
      if (this.heldStdio.has(admission)) throw new Error('The held STDIO constructor was already claimed or ended.')
      state = unstartedHeldStdioState()
      state.notify = () => owner.notifyP5McpClientSettlement(admission)
      this.heldStdio.set(admission, state)
      const actual = state
      const processEnv = { ...resolved.env }
      const transport = new StdioClientTransport({ command: resolved.command, args: [...resolved.args], cwd: resolved.cwd, env: processEnv, stderr: 'pipe' })
      actual.transport = transport; actual.constructor = 'started'; actual.initialize = 'pending'
      // Only the actual transport owns a value copy after this handoff. Rechecks
      // reopen original encrypted refs; this admission cannot construct again.
      for (const name of Object.keys(resolved.env)) delete resolved.env[name]
      // Drain actual stderr without retaining or logging child/environment data.
      transport.stderr?.on('data', () => {})
      const start = transport.start.bind(transport), send = transport.send.bind(transport), close = transport.close.bind(transport)
      const onAbort = () => { void this.closeForHeldApi(admission) }
      held.signal.addEventListener('abort', onAbort, { once: true }); actual.removeAbort = () => held.signal.removeEventListener('abort', onAbort)
      // The actual SDK installs its callbacks BEFORE start. Preserve its close
      // handler and observe the direct child event; SDK close() alone is weaker.
      transport.start = async () => {
        await owner.revalidateP5McpHttpAdmission(admission)
        owner.readP5McpStdioAdmission(admission)
        if (actual.closeRequested) throw new Error('The held STDIO start ended before spawn.')
        const onclose = transport.onclose
        transport.onclose = () => {
          actual.childClosed = true; actual.observeClose()
          for (const name of Object.keys(processEnv)) delete processEnv[name]
          try { onclose?.() } finally { actual.notify() }
        }
        actual.spawnIssued = true
        return this.observeRequest(admission, start())
      }
      transport.send = async message => {
        if ('method' in message && message.method === 'tools/call') owner.requireP5McpToolUse(admission)
        await owner.revalidateP5McpHttpAdmission(admission)
        owner.readP5McpStdioAdmission(admission)
        if (actual.closeRequested) throw new Error('The held STDIO client closed issuance.')
        // No await follows these original file/source/key/authority fences before
        // the SAME actual SDK stdin.write. Setup cannot tools/call here.
        return this.observeRequest(admission, send(message))
      }
      transport.close = () => {
        actual.closeRequested = true
        actual.closing ??= (async () => {
          actual.close = 'pending'
          try {
            await close() // exactly one actual SDK close flight, also used by late client.close
            if (actual.spawnIssued) await actual.closed
            for (const name of Object.keys(processEnv)) delete processEnv[name]
            actual.close = 'known'
          } catch { actual.close = 'unknown' }
          finally { actual.removeAbort?.(); actual.notify() }
        })()
        return actual.closing
      }
      try {
        actual.creation = createMCPClient({ transport }).then(client => {
          actual.client = client; actual.initialize = 'known'; actual.notify()
          if (actual.closeRequested) void this.closeForHeldApi(admission)
          return client
        }, error => { actual.initialize = 'unknown'; actual.notify(); void this.closeForHeldApi(admission); throw error })
        // The awaited owner below consumes the same promise; this observer only
        // prevents an abandoned late rejection, never changes physical truth.
        void actual.creation.catch(() => {})
      } catch (error) { actual.initialize = 'unknown'; void this.closeForHeldApi(admission); throw error }
    }
    const held = owner.readP5McpStdioAdmission(admission)
    if (!state.creation || state.closeRequested) throw new Error('The held STDIO initialization ended; no reissue.')
    const client = await this.waitForHeld(admission, state.creation, held.resolved.startupTimeoutMs)
    owner.readP5McpStdioAdmission(admission)
    return client
  }

  async listForHeldApi(admission: P5McpClientAdmission): Promise<Record<string, Tool>> {
    const owner = await import('./mcpGatewayAdmission')
    const client = await this.openForHeldApi(admission), state = this.heldStdio.get(admission)!
    await owner.revalidateP5McpHttpAdmission(admission)
    const held = owner.readP5McpStdioAdmission(admission)
    state.list = 'pending'
    const physical = client.tools().then(tools => { state.list = 'known'; state.notify(); return tools }, error => {
      state.list = 'unknown'; state.notify(); throw error
    })
    void physical.catch(() => {})
    return this.waitForHeld(admission, physical, held.resolved.startupTimeoutMs)
  }
  async executeForHeldApi(admission: P5McpClientAdmission): Promise<unknown> {
    const owner = await import('./mcpGatewayAdmission')
    owner.requireP5McpToolUse(admission)
    try {
      const tools = await this.listForHeldApi(admission), held = owner.readP5McpStdioAdmission(admission)
      if (!held.toolName) throw new Error('The actual STDIO tool identity is unavailable.')
      const target = tools[held.toolName]
      if (!target || typeof target.execute !== 'function') throw new Error('The fresh STDIO tool is unavailable.')
      const args = await owner.validateP5McpHttpTool(admission, held.toolName, target)
      owner.readP5McpStdioAdmission(admission)
      const state = this.heldStdio.get(admission)!
      state.execute = 'pending'
      const physical = Promise.resolve(Reflect.apply(target.execute, target, [args, { abortSignal: held.signal }])).then(result => {
        state.execute = 'known'; state.notify(); return result
      }, error => { state.execute = 'unknown'; state.notify(); throw error })
      void physical.catch(() => {})
      return await this.waitForHeld(admission, physical, held.resolved.toolCallTimeoutMs)
    } finally { void this.closeForHeldApi(admission) }
  }
  /** Cleanup is custody, usable after Stop/authority loss. No read/positive guard. */
  closeForHeldApi(admission: P5McpClientAdmission): Promise<void> {
    let state = this.heldStdio.get(admission)
    if (!state) {
      state = unstartedHeldStdioState(); state.closeRequested = true
      this.heldStdio.set(admission, state) // seals delayed construction; still no close/constructor fact
      return import('./mcpGatewayAdmission').then(owner => { owner.notifyP5McpClientSettlement(admission) })
    }
    state.closeRequested = true
    if (!state.transport) { state.notify(); return Promise.resolve() }
    if (state.closing) return state.closing
    const actualClose = state.transport.close()
    return state.closing ?? actualClose
  }
  readHeldApiSettlement(admission: P5McpClientAdmission) {
    const state = this.heldStdio.get(admission)
    if (!state) return Object.freeze({ constructor: 'not_started' as const, requests: 'not_started' as const, initialize: 'not_started' as const, list: 'not_started' as const, execute: 'not_started' as const, close: 'not_started' as const })
    return Object.freeze({ constructor: state.constructor, requests: state.requests.size ? 'pending' as const : state.requestUnknown ? 'unknown' as const : state.requestIssued ? 'known' as const : 'not_started' as const,
      initialize: state.initialize, list: state.list, execute: state.execute, close: state.close })
  }

  private observeInitialStage<T>(admission: P5McpClientAdmission, stage: 'initialize' | 'list' | 'execute', promise: Promise<T>): Promise<T> {
    const state = this.heldStdio.get(admission)!
    state[stage] = 'pending'
    return promise.then(result => { state[stage] = 'known'; state.notify(); return result }, error => {
      state[stage] = 'unknown'; state.notify(); throw error
    })
  }
  /** Proxy only the actual SDK promises; names/cache answers never create these facts. */
  private observeInitialClient(admission: P5McpClientAdmission, client: MCPClient): MCPClient {
    return new Proxy(client, { get: (target, property) => {
      if (property === 'tools') return (...args: unknown[]) => {
        const promise: Promise<Record<string, Tool>> = Reflect.apply(target.tools, target, args)
        return this.observeInitialStage(admission, 'list', promise).then(tools => Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
          const observed = new Proxy(entry, { get: (tool, field) => {
            const value = Reflect.get(tool, field, tool)
            if (field !== 'execute' || typeof value !== 'function') return value
            return (...input: unknown[]) => this.observeInitialStage(admission, 'execute', Promise.resolve(Reflect.apply(value, tool, input)))
          } })
          return [name, observed]
        })))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  private initialCreation(admission: P5McpClientAdmission | undefined, promise: Promise<MCPClient>): Promise<MCPClient> {
    if (!admission) return promise
    const observed = this.observeInitialStage(admission, 'initialize', promise).then(client => this.observeInitialClient(admission, client))
    // Same observed promise is returned to the existing timeout/caller. A late
    // rejection is retained by its actual owner, never an orphan sibling.
    void observed.catch(() => {})
    return observed
  }

  /** The ordinary caller keeps the actual SDK close return/error timing. A
   * separate observation of THAT same raw flight plus child onclose owns facts;
   * it is not added to the gating original ledger until management seals it. */
  private observeInitialTransport(admission: P5McpClientAdmission, transport: StdioClientTransport, produced: ResolvedStdioGatewayProcessConfig, owner: typeof import('./mcpGatewayAdmission')): void {
    owner.assertInitialStdioObservationIssue(admission)
    if (this.heldStdio.has(admission)) throw new Error('The original ordinary STDIO observer cannot issue twice.')
    const state = unstartedHeldStdioState()
    state.constructor = 'started'; state.transport = transport; state.notify = () => owner.notifyP5McpClientSettlement(admission)
    this.heldStdio.set(admission, state)
    owner.observeInitialStdioConstructor(admission)
    const start = transport.start.bind(transport), send = transport.send.bind(transport), close = transport.close.bind(transport)
    const signal = owner.readInitialStdioObservationSignal(admission)
    const abort = () => { void this.closeForHeldApi(admission) }
    signal.addEventListener('abort', abort, { once: true }); state.removeAbort = () => signal.removeEventListener('abort', abort)
    // Provenance comparison finished before constructor/startup timer. Ordinary
    // SDK start/send add no optional Redis/value await to their timing budget.
    transport.start = async () => {
      owner.assertInitialStdioObservationIssue(admission)
      if (state.closeRequested) throw new Error('The original STDIO start was sealed.')
      const onclose = transport.onclose
      transport.onclose = () => {
        state.childClosed = true; state.observeClose()
        for (const name of Object.keys(produced.env)) delete produced.env[name]
        try { onclose?.() } finally { state.notify() }
      }
      state.spawnIssued = true
      return this.observeRequest(admission, start())
    }
    transport.send = async message => {
      owner.assertInitialStdioObservationIssue(admission)
      if (state.closeRequested) throw new Error('The original STDIO send was sealed.')
      return this.observeRequest(admission, send(message))
    }
    transport.close = () => {
      state.closeRequested = true
      if (!state.rawClosing) {
        state.close = 'pending'
        try { state.rawClosing = close() } catch (error) { state.rawClosing = Promise.reject(error) }
        const raw = state.rawClosing
        state.closing = (async () => {
          try { await raw; if (state.spawnIssued) await state.closed; state.close = 'known' }
          catch { state.close = 'unknown' }
          finally {
            if (state.close === 'known') for (const name of Object.keys(produced.env)) delete produced.env[name]
            state.removeAbort?.(); state.notify()
          }
        })()
      }
      return state.rawClosing
    }
  }

  private async createTransport(params: {
    gateway: MCPGateway
    userId?: string
    projectPath?: string | null
    /** A launch the caller already resolved, so the process started is exactly the one it named. */
    resolved?: ResolvedStdioGatewayProcessConfig
    originalObservation?: P5McpClientAdmission
  }) {
    const legacy = params.resolved ?? (await resolveStdioGatewayProcessConfig(params))
    const resolved = params.originalObservation ? { ...legacy, args: [...legacy.args], env: { ...legacy.env } } : legacy
    let observationOwner: typeof import('./mcpGatewayAdmission') | undefined
    if (params.originalObservation) {
      const owner = await import('./mcpGatewayAdmission'); observationOwner = owner
      await owner.observeInitialStdioProduced(params.originalObservation, resolved)
      owner.assertInitialStdioObservationIssue(params.originalObservation)
    }
    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      cwd: resolved.cwd,
      env: resolved.env,
      stderr: 'pipe'
    })

    if (params.originalObservation) this.observeInitialTransport(params.originalObservation, transport, resolved, observationOwner!)
    const stderrChunks: string[] = []
    transport.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
    })

    return {
      transport,
      stderrChunks,
      resolved
    }
  }

  async discoverTools(params: {
    gateway: MCPGateway
    userId?: string
    projectPath?: string | null
    /** Gateway discovery resolves the launch first, because its saved tool list is keyed on it. */
    resolved?: ResolvedStdioGatewayProcessConfig
    originalObservation?: P5McpClientAdmission
  }): Promise<ToolWithName[]> {
    let mcpClient: MCPClient | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const { gateway } = params
    const { transport, stderrChunks, resolved } = await this.createTransport(params)

    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`STDIO tool discovery timed out after ${resolved.startupTimeoutMs}ms`)),
          resolved.startupTimeoutMs
        )
      })

      logger.debug(`[STDIO MCP] Discovering tools from ${gateway.name}`)
      mcpClient = (await Promise.race([this.initialCreation(params.originalObservation, createMCPClient({ transport: transport as any })), timeout])) as MCPClient
      const tools = (await Promise.race([mcpClient.tools(), timeout])) as Record<string, Tool>

      return Object.entries(tools).map(([name, tool]) => ({
        ...tool,
        name
      })) as ToolWithName[]
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown STDIO discovery error'
      throw new Error(buildErrorMessage(`Failed to discover STDIO MCP tools: ${message}`, stderrChunks))
    } finally {
      if (typeof timeoutId !== 'undefined') clearTimeout(timeoutId)
      if (mcpClient) {
        await mcpClient.close().catch(() => undefined)
      } else {
        closeUnstartedTransport(transport, gateway.name)
      }
    }
  }

  async healthCheck(params: {
    gateway: MCPGateway
    userId?: string
    projectPath?: string | null
  }): Promise<StdioMCPGatewayHealth> {
    let mcpClient: MCPClient | undefined
    let transport: StdioClientTransport | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const created = await this.createTransport(params)
      transport = created.transport
      const { resolved } = created
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`STDIO health check timed out after ${resolved.startupTimeoutMs}ms`)),
          resolved.startupTimeoutMs
        )
      })

      mcpClient = (await Promise.race([createMCPClient({ transport: transport as any }), timeout])) as MCPClient
      const tools = (await Promise.race([mcpClient.tools(), timeout])) as Record<string, Tool>

      return {
        available: true,
        toolCount: Object.keys(tools).length
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'STDIO health check failed'
      }
    } finally {
      if (typeof timeoutId !== 'undefined') clearTimeout(timeoutId)
      if (mcpClient) {
        await mcpClient.close().catch(() => undefined)
      } else if (transport) {
        closeUnstartedTransport(transport, params.gateway.name)
      }
    }
  }

  async createClient(params: {
    gateway: MCPGateway
    userId?: string
    projectPath?: string | null
    /** Exact already-resolved launch; ordinary callers retain current resolution. */
    resolved?: ResolvedStdioGatewayProcessConfig
    originalObservation?: P5McpClientAdmission
  }): Promise<{
    client: MCPClient
    stderrChunks: string[]
    toolCallTimeoutMs: number
  }> {
    const { transport, stderrChunks, resolved } = await this.createTransport(params)
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`STDIO client startup timed out after ${resolved.startupTimeoutMs}ms`)),
          resolved.startupTimeoutMs
        )
      })

      const client = (await Promise.race([this.initialCreation(params.originalObservation, createMCPClient({ transport: transport as any })), timeout])) as MCPClient
      return {
        client,
        stderrChunks,
        toolCallTimeoutMs: resolved.toolCallTimeoutMs
      }
    } catch (error) {
      closeUnstartedTransport(transport, params.gateway.name)
      throw error
    } finally {
      if (typeof timeoutId !== 'undefined') clearTimeout(timeoutId)
    }
  }
}

export const stdioMCPGatewayClient = new StdioMCPGatewayClient()
