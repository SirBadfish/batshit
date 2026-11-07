import { afterAll, afterEach, beforeEach, expect, vi, type Mock } from 'vitest'

// This opt-in module is the FIRST import of its handler owners. Set supported
// roots and register physical refusals before any production static import.
const scope = await vi.hoisted(async () => {
  const real = process.env.VITEST_USE_REAL_REDIS === 'true'
  const previousHome = process.env.BATSHIT_HOME_DIR
  const previousRuntime = process.env.BATSHIT_AGENT_RUNTIME_ROOT
  const originalFetch = globalThis.fetch
  const fetchAttempts = { count: 0 }
  const blockedFetch: typeof fetch = async () => {
    fetchAttempts.count += 1
    throw new Error('Network fetch is not admitted in the default send-handler fixture.')
  }
  let root: string | undefined
  if (!real) {
    const { mkdtempSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    root = realpathSync(mkdtempSync(join(tmpdir(), 'batshit-send-handler-')))
    process.env.BATSHIT_HOME_DIR = root
    process.env.BATSHIT_AGENT_RUNTIME_ROOT = root
    globalThis.fetch = blockedFetch
  }
  return { real, root, previousHome, previousRuntime, originalFetch, blockedFetch, fetchAttempts, physicalAttempts: 0 }
})

vi.mock('redis', async importOriginal => {
  const actual = await importOriginal<typeof import('redis')>()
  if (scope.real) return actual
  const createClient = vi.fn(() => {
    scope.physicalAttempts += 1
    throw new Error('Physical Redis is not admitted in the default send-handler fixture.')
  })
  const defaultExport = (actual as any).default
  return { ...actual, createClient,
    ...(defaultExport ? { default: { ...defaultExport, createClient } } : {}) }
})
vi.mock('$lib/server/visualIndicatorService', async importOriginal => {
  const actual = await importOriginal<typeof import('$lib/server/visualIndicatorService')>()
  if (scope.real) return actual
  return { ...actual, initializeKeyspaceNotifications: vi.fn(async () => {}),
    setupSessionMonitoring: vi.fn(async () => async () => {}) }
})
vi.mock('$lib/server/sseExternalSubscriber', async importOriginal => {
  const actual = await importOriginal<typeof import('$lib/server/sseExternalSubscriber')>()
  if (scope.real) return actual
  // No external publisher exists in the fake lane. Retain the actual hub sinks,
  // forwarding, recorder and close owner; never claim an external subscriber is ready.
  return { ...actual, ensureSseExternalSubscriber: vi.fn(async () => false),
    waitForSseExternalSubscriber: vi.fn(async () => false) }
})

import { rmSync } from 'node:fs'
import { createClient } from 'redis'
import { redis } from '$lib/server/redis'
import { readSendHandlerSessionForCompile, sendHandlerFixtureClient } from './sendHandlerFixtureReads'
import { buildDynamicOnlySelectionResetKey } from '$lib/server/services/mcpRuntimePolicy'

type Options = { sessionIds: () => readonly string[]; rawSessionRead?: boolean; strictCompiler?: boolean;
  /** These exact fake users start AFTER the existing v1 reset; this is fixture input,
   * never a simulated migration result or authority for a real lane. Evaluated after reset. */
  postStartupMcpUsers?: () => readonly string[] }
let options: Options | undefined
const executeDescriptor = Object.getOwnPropertyDescriptor(redis, 'execute')
const compilerDescriptor = Object.getOwnPropertyDescriptor(redis, 'getSessionForCompile')
const clientDescriptor = Object.getOwnPropertyDescriptor(redis, 'getClient')
const originalExecute = !scope.real && vi.isMockFunction(redis.execute) ? (redis.execute as Mock<typeof redis.execute>).getMockImplementation() : undefined
const wrappedExecute = vi.fn(async (operation: (client: any) => Promise<any>) => {
  if (!originalExecute) throw new Error('The send-handler fixture needs its existing default Redis execute implementation.')
  return originalExecute((client: any) => operation(options?.rawSessionRead === false ? client :
    sendHandlerFixtureClient(client, () => options?.sessionIds() ?? [])))
})

function installReads() {
  if (scope.real) return
  if (!originalExecute) throw new Error('The send-handler fixture needs its existing default Redis execute implementation.')
  Object.defineProperty(redis, 'execute', { configurable: true, writable: true, value: wrappedExecute })
  if (options?.strictCompiler) {
    Object.defineProperty(redis, 'getSessionForCompile', {
      configurable: true, writable: true,
      value: vi.fn((sessionId: string) => readSendHandlerSessionForCompile(operation => redis.execute(operation), sessionId))
    })
    // Artifacts' real metadata reader asks a RedisService instance for its client.
    // The default constructor already returns this same facade/store; expose that
    // existing client rather than replacing the Artifact/Fabric projection.
    Object.defineProperty(redis, 'getClient', { configurable: true, writable: true,
      value: vi.fn(() => redis.execute(async client => client)) })
  }
}
function restoreReads() {
  if (scope.real) return
  if (executeDescriptor) Object.defineProperty(redis, 'execute', executeDescriptor)
  else delete (redis as any).execute
  if (compilerDescriptor) Object.defineProperty(redis, 'getSessionForCompile', compilerDescriptor)
  else delete (redis as any).getSessionForCompile
  if (clientDescriptor) Object.defineProperty(redis, 'getClient', clientDescriptor)
  else delete (redis as any).getClient
}
function expectNoPhysicalClients() {
  if (scope.real) return
  expect(scope.physicalAttempts, 'Unplanned physical Redis factory attempts').toBe(0)
  expect(scope.fetchAttempts.count, 'Unplanned network fetch attempts').toBe(0)
  expect(createClient).not.toHaveBeenCalled()
}

// Install before a later owner import captures its pristine failure-injection seam.
installReads()
beforeEach(() => { expectNoPhysicalClients(); installReads(); if (!scope.real) globalThis.fetch = scope.blockedFetch })
afterEach(() => {
  try { expectNoPhysicalClients() }
  finally { restoreReads() }
})
afterAll(() => {
  try { expectNoPhysicalClients() }
  finally {
    restoreReads()
    if (!scope.real) {
      if (scope.previousHome === undefined) delete process.env.BATSHIT_HOME_DIR
      else process.env.BATSHIT_HOME_DIR = scope.previousHome
      if (scope.previousRuntime === undefined) delete process.env.BATSHIT_AGENT_RUNTIME_ROOT
      else process.env.BATSHIT_AGENT_RUNTIME_ROOT = scope.previousRuntime
      globalThis.fetch = scope.originalFetch
      if (scope.root) rmSync(scope.root, { recursive: true, force: true })
    }
  }
})

export function useSendHandlerFixture(configuration: Options) {
  if (options) throw new Error('One handler owner configures its fixture once.')
  options = configuration
  installReads()
  const postStartupUsers = configuration.postStartupMcpUsers
  if (scope.real || !postStartupUsers) return
  // Registered at the owning call AFTER its fake-store harness, before owner setup/events.
  beforeEach(async () => {
    const users = postStartupUsers()
    if (!Array.isArray(users) || users.some(user => typeof user !== 'string' || !user || user.trim() !== user)) {
      throw new Error('Post-startup MCP fixture users must be exact explicit nonempty IDs.')
    }
    if (!originalExecute) throw new Error('Post-startup MCP input requires the existing same-store fake client.')
    await originalExecute(async (client: any) => {
      for (const user of new Set(users)) await client.set(buildDynamicOnlySelectionResetKey(user), '2026-10-27T00:00:00.000Z')
    })
  })
}

/** Only the helper's explicit factory-refusal test resets its intentional attempts. */
export const sendHandlerPhysicalFixture = scope
