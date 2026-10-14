import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, it } from 'vitest'

// Execute the actual helper/suite bytes with captured Vitest hook registration and
// no socket-capable dependency. This is hook/admission proof, never real Redis proof.
const sourceRoot = process.env.SA122_ADMISSION_SOURCE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const requireNode = createRequire(import.meta.url)
const harnessSource = readFileSync(resolve(sourceRoot, 'src/lib/test-utils/redis-memory.ts'), 'utf8')
const suiteSource = readFileSync(resolve(sourceRoot, 'src/lib/server/services/appActions/settings/conditionalAgentSettings.redis.test.ts'), 'utf8')
const runId = 'a'.repeat(40)
const port = 59123
const originalUrl = 'redis://127.0.0.1:59123/15'
const allocationPath = '/fresh-owned-evidence/settings-redis-allocation.json'
const receiptPath = '/fresh-owned-evidence/settings-redis-admission.json'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(real = true) {
  const hooks = { beforeAll: [] as (() => Promise<void>)[], beforeEach: [] as (() => Promise<void>)[],
    afterEach: [] as (() => Promise<void>)[], afterAll: [] as (() => Promise<void>)[], tests: [] as (() => Promise<void>)[] }
  const effects = { create: 0, scan: 0, unlink: 0, seed: 0, del: 0, adminDisconnect: 0, adminQuit: 0,
    appExecute: 0, appDisconnect: 0, appCommandDisconnect: 0, reset: 0, record: 0, sync: 0, fileClose: 0, dirSync: 0, dirClose: 0 }
  const env: Record<string, string | undefined> = { VITEST_USE_REAL_REDIS: real ? 'true' : 'false',
    BATSHIT_REDIS_TEST_URL: originalUrl, REDIS_URL: originalUrl, VITEST_POOL_ID: '1',
    SA122_SETTINGS_REDIS_ALLOCATION: allocationPath }
  const dynamicEnv: Record<string, string | undefined> = { REDIS_URL: originalUrl }
  let allocation: any = { schemaVersion: 1, allocationId: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date().toISOString(), host: '127.0.0.1', port, database: 14, runId, receiptPath }
  let rawAllocation: string | undefined
  let receipt: any
  let recordGate: Promise<void> | undefined
  let receiptFailure: 'open' | 'write' | 'sync' | 'close' | 'dirOpen' | 'dirSync' | 'dirClose' | undefined
  let pairedCloseFailure: 'file' | 'directory' | undefined
  const receiptErrors = {
    open: new Error('receipt already exists'), write: new Error('receipt write failed'), sync: new Error('receipt sync failed'),
    close: new Error('receipt close failed'), dirOpen: new Error('receipt directory open failed'),
    dirSync: new Error('receipt directory sync failed'), dirClose: new Error('receipt directory close failed')
  }
  const appCloseError = new Error('app close failed')
  const adminCloseError = new Error('admin disconnect failed')
  let adminCloseFailure = false
  let regularFile = true
  let adminReadFailure = false
  let appReadFailure = false
  let adminConnectFailure = false
  let quitFailure = false
  let appCloseFailure = false
  let appAcquireGate: Promise<void> | undefined
  let appLateEnvSync = false
  const makeClient = (id: number) => ({
    isOpen: false, isReady: false,
    connection: { id, db: 14, laddr: `127.0.0.1:${port}`, user: 'must-not-be-recorded' } as any,
    server: `# Server\r\nredis_version:8.10.1\r\nrun_id:${runId}\r\ntcp_port:${port}\r\n`,
    size: 0 as any, jsonReply: null as any,
    async connect() { this.isOpen = true; if (adminConnectFailure) throw new Error('connect failed'); this.isReady = true },
    async ping() { return 'PONG' },
    async clientInfo() { if ((id === 11 && adminReadFailure) || (id === 12 && appReadFailure)) throw new Error('read failed'); return this.connection },
    async info(section: string) { assert.equal(section, 'server'); return this.server },
    async dbSize() { return this.size },
    async sendCommand(command: string[]) { assert.deepEqual(Array.from(command), ['JSON.GET', 'sa122:settings:admission:missing', '$']); return this.jsonReply },
    async scan() { effects.scan++; return { cursor: '0', keys: ['test:key'] } },
    async unlink() { effects.unlink++; return 1 },
    async disconnect() {
      if (id === 11) effects.adminDisconnect++; else effects.appCommandDisconnect++
      this.isOpen = false; this.isReady = false
      if (id === 11 && adminCloseFailure) throw adminCloseError
    },
    async quit() { effects.adminQuit++; this.isOpen = false; this.isReady = false; if (quitFailure) throw new Error('quit failed') }
  })
  const admin = makeClient(11)
  const app = makeClient(12)
  const service = {
    async execute(operation: (client: typeof app) => Promise<unknown>) {
      effects.appExecute++; if (appAcquireGate) await appAcquireGate
      if (appLateEnvSync) {
        // Match real getClient's Vitest env synchronization after lazy URL resolution.
        env.REDIS_URL = 'redis://127.0.0.1:59123/14'; dynamicEnv.REDIS_URL = env.REDIS_URL
      }
      app.isOpen = true; app.isReady = true; return operation(app)
    },
    async disconnect() { effects.appDisconnect++; app.isOpen = false; app.isReady = false; if (appCloseFailure) throw appCloseError },
    async __resetTestStore() { effects.reset++ },
    json: { async set() { effects.seed++ }, async get() { return null } },
    async del() { effects.del++; return 1 }
  }
  const mockedFs = {
    async lstat(path: string) { assert.equal(path, allocationPath); return { isFile: () => regularFile, isSymbolicLink: () => !regularFile } },
    async readFile(path: string, encoding: string) { assert.equal(path, allocationPath); assert.equal(encoding, 'utf8'); return rawAllocation ?? JSON.stringify(allocation) },
    async open(path: string, flags: string, mode?: number) {
      if (path === receiptPath) {
        assert.equal(flags, 'wx'); assert.equal(mode, 0o600)
        if (receiptFailure === 'open') throw receiptErrors.open
        return {
          async writeFile(raw: string, encoding: string) { effects.record++; assert.equal(encoding, 'utf8'); if (recordGate) await recordGate; if (receiptFailure === 'write') throw receiptErrors.write; receipt = JSON.parse(raw) },
          async sync() { effects.sync++; if (receiptFailure === 'sync') throw receiptErrors.sync },
          async close() { effects.fileClose++; if (receiptFailure === 'close' || pairedCloseFailure === 'file') throw receiptErrors.close }
        }
      }
      assert.equal(path, '/fresh-owned-evidence'); assert.equal(flags, 'r')
      if (receiptFailure === 'dirOpen') throw receiptErrors.dirOpen
      return {
        async sync() { effects.dirSync++; if (receiptFailure === 'dirSync') throw receiptErrors.dirSync },
        async close() { effects.dirClose++; if (receiptFailure === 'dirClose' || pairedCloseFailure === 'directory') throw receiptErrors.dirClose }
      }
    }
  }
  const capturedVitest = {
    beforeAll: (callback: () => Promise<void>) => hooks.beforeAll.push(callback),
    beforeEach: (callback: () => Promise<void>) => hooks.beforeEach.push(callback),
    afterEach: (callback: () => Promise<void>) => hooks.afterEach.push(callback),
    afterAll: (callback: () => Promise<void>) => hooks.afterAll.push(callback),
    describe: { runIf: (gate: boolean) => (_name: string, callback: () => void) => { if (gate) callback() } },
    it: (_name: string, callback: () => Promise<void>) => hooks.tests.push(callback),
    expect: () => { throw new Error('Real test assertions must not execute in this admission proof.') }
  }
  const load = (source: string, filename: string, extra: Record<string, unknown> = {}) => {
    const exports = {}
    const module = { exports }
    const require = (name: string) => {
      if (Object.hasOwn(extra, name)) return extra[name]
      if (name === 'vitest') return capturedVitest
      if (name === 'redis') return { createClient: (config: any) => { effects.create++; assert.equal(config.database, Number(new URL(config.url).pathname.slice(1))); return admin }, AbortError: class extends Error {} }
      if (name === '$env/dynamic/private') return { env: dynamicEnv }
      if (name === '$lib/server/redis') return { redis: service }
      if (name === 'node:fs/promises') return mockedFs
      if (name === 'node:path') return requireNode(name)
      throw new Error(`Unexpected dependency ${name}; no real Redis/network dependency is permitted.`)
    }
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: filename })
    vm.runInNewContext(compiled.outputText, { module, exports, require, process: { env }, URL, Date, Error, AggregateError, Promise }, { filename })
    return module.exports as any
  }
  const helper = load(harnessSource, 'redis-memory.ts')
  return { hooks, effects, env, dynamicEnv, admin, app, service, helper, receiptErrors, appCloseError, adminCloseError,
    get allocation() { return allocation }, set allocation(value: any) { allocation = value },
    set rawAllocation(value: string) { rawAllocation = value }, get receipt() { return receipt },
    set recordGate(value: Promise<void>) { recordGate = value }, set receiptFailure(value: typeof receiptFailure) { receiptFailure = value },
    set pairedCloseFailure(value: typeof pairedCloseFailure) { pairedCloseFailure = value },
    set adminCloseFailure(value: boolean) { adminCloseFailure = value },
    set regularFile(value: boolean) { regularFile = value }, set adminReadFailure(value: boolean) { adminReadFailure = value },
    set appReadFailure(value: boolean) { appReadFailure = value }, set adminConnectFailure(value: boolean) { adminConnectFailure = value },
    set quitFailure(value: boolean) { quitFailure = value }, set appCloseFailure(value: boolean) { appCloseFailure = value },
    set appAcquireGate(value: Promise<void>) { appAcquireGate = value },
    set appLateEnvSync(value: boolean) { appLateEnvSync = value },
    loadSuite() { load(suiteSource, 'conditionalAgentSettings.redis.test.ts', {
      '$lib/test-utils/redis-memory': helper,
      './conditionalAgentSettings': {
        createConditionalSettingsStore: () => ({ async read() { throw new Error('Offline admission proof stops at the real Lua case boundary.') } }),
        CONDITIONAL_SETTINGS_WRITE_SCRIPT: '', SETTINGS_SNAPSHOT_PATHS: []
      }
    }) },
    async teardown() { for (const hook of hooks.afterAll) await hook() }
  }
}

function noMutations(f: ReturnType<typeof fixture>) {
  assert.equal(f.effects.scan, 0); assert.equal(f.effects.unlink, 0)
  assert.equal(f.effects.seed, 0); assert.equal(f.effects.del, 0)
}
async function refused(f: ReturnType<typeof fixture>, validateError?: (error: unknown) => boolean) {
  if (validateError) await assert.rejects(f.hooks.beforeAll[0](), validateError)
  else await assert.rejects(f.hooks.beforeAll[0]())
  await assert.rejects(f.hooks.beforeEach[0]())
  for (const hook of f.hooks.afterEach) await hook()
  // Even if a runner invokes a body despite beforeAll refusal, seed must refuse first.
  if (f.hooks.tests[0]) await assert.rejects(f.hooks.tests[0](), /not completed admission/)
  noMutations(f)
  await f.teardown()
  assert.equal(f.admin.isOpen, false); assert.equal(f.app.isOpen, false)
  assert.equal(f.env.REDIS_URL, originalUrl); assert.equal(f.dynamicEnv.REDIS_URL, originalUrl)
}

describe('real Redis harness: optional admission without sockets', () => {
  it('default fake lane resets only; does not create a client or call admission', async () => {
    const f = fixture(false); let admissions = 0
    const handle = f.helper.useRedisTestServer({ beforeCleanupAdmission: async () => { admissions++ } })
    await f.hooks.beforeAll[0](); await f.hooks.beforeEach[0](); await f.teardown()
    assert.equal(admissions, 0); assert.equal(f.effects.create, 0); assert.equal(f.effects.reset, 1)
    assert.equal(handle.isAdmitted(), false); noMutations(f)
  })
  it('no-hook real caller keeps the normal remap and cleanup behavior', async () => {
    const f = fixture(); const handle = f.helper.useRedisTestServer()
    await f.hooks.beforeAll[0](); assert.equal(handle.isAdmitted(), true)
    await f.hooks.beforeEach[0](); assert.equal(f.effects.scan, 1); assert.equal(f.effects.unlink, 1)
    await f.teardown(); assert.equal(f.effects.adminQuit, 1); assert.equal(f.env.REDIS_URL, originalUrl)
  })
  it('awaits exactly one hook before cleanup and refuses premature use', async () => {
    const f = fixture(); const gate = deferred(); const entered = deferred(); let calls = 0
    const handle = f.helper.useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }: any) => {
      calls++; assert.equal(adminClient, f.admin); assert.equal(resolvedUrl, 'redis://127.0.0.1:59123/14'); entered.resolve(); await gate.promise
    } })
    const start = f.hooks.beforeAll[0](); await entered.promise
    assert.equal(handle.isAdmitted(), false); await assert.rejects(f.hooks.beforeEach[0]()); noMutations(f)
    gate.resolve(); await start; assert.equal(calls, 1)
    await f.hooks.beforeEach[0](); await f.hooks.beforeEach[0](); assert.equal(calls, 1); assert.equal(f.effects.scan, 2)
    await f.teardown()
  })
  it('callback rejection closes its partial client and never clears', async () => {
    const f = fixture(); f.helper.useRedisTestServer({ beforeCleanupAdmission: async () => { throw new Error('refusal') } })
    await refused(f); assert.equal(f.effects.adminDisconnect, 1); assert.equal(f.effects.adminQuit, 0)
  })
  it('connect rejection closes the existing partial client and restores env', async () => {
    const f = fixture(); f.adminConnectFailure = true
    f.helper.useRedisTestServer({ beforeCleanupAdmission: async () => { throw new Error('must not call') } })
    await refused(f); assert.equal(f.effects.adminDisconnect, 1)
  })
  it('teardown prevents a late successful hook from admitting or clearing', async () => {
    const f = fixture(); const gate = deferred(); const entered = deferred()
    const handle = f.helper.useRedisTestServer({ beforeCleanupAdmission: async () => { entered.resolve(); await gate.promise } })
    const start = f.hooks.beforeAll[0](); await entered.promise
    await f.teardown(); gate.resolve(); await assert.rejects(start, /after teardown/)
    assert.equal(handle.isAdmitted(), false); await assert.rejects(f.hooks.beforeEach[0]()); noMutations(f)
    assert.equal(f.effects.adminDisconnect, 1)
  })
  it('restores environment when normal owned-client quit fails', async () => {
    const f = fixture(); f.quitFailure = true; f.helper.useRedisTestServer()
    await f.hooks.beforeAll[0](); await assert.rejects(f.teardown(), /quit failed/)
    assert.equal(f.env.REDIS_URL, originalUrl); assert.equal(f.dynamicEnv.REDIS_URL, originalUrl)
  })
  it('DB0 URL refusal precedes client creation and the hook', async () => {
    const f = fixture(); f.env.BATSHIT_REDIS_TEST_URL = 'redis://127.0.0.1:59123/0'; let calls = 0
    f.helper.useRedisTestServer({ beforeCleanupAdmission: async () => { calls++ } })
    await refused(f); assert.equal(f.effects.create, 0); assert.equal(calls, 0)
  })
})

describe('Settings DB14 admission: actual suite hooks with read-only fakes', () => {
  it('default lane never reads expectations/acquires app/records or adds real cases', async () => {
    const f = fixture(false); delete f.env.SA122_SETTINGS_REDIS_ALLOCATION; f.loadSuite()
    await f.hooks.beforeAll[0](); await f.hooks.beforeEach[0](); await f.teardown()
    assert.equal(f.hooks.tests.length, 0); assert.equal(f.effects.create, 0); assert.equal(f.effects.appExecute, 0)
    assert.equal(f.effects.record, 0); noMutations(f)
  })
  it('holds both cleanup and seven-case fixture authority until durable recording completes', async () => {
    const f = fixture(); const gate = deferred(); f.recordGate = gate.promise; f.loadSuite()
    const start = f.hooks.beforeAll[0]()
    // Wait for the mocked write barrier, without timers/services or running a real case.
    for (let step = 0; step < 100 && !f.effects.record; step++) await Promise.resolve()
    assert.equal(f.effects.record, 1); assert.equal(f.effects.appExecute, 1)
    await assert.rejects(f.hooks.beforeEach[0]()); for (const hook of f.hooks.afterEach) await hook(); noMutations(f)
    gate.resolve(); await start
    assert.equal(f.hooks.tests.length, 9); assert.equal(f.effects.sync, 1); assert.equal(f.effects.fileClose, 1)
    assert.equal(f.effects.dirSync, 1); assert.equal(f.effects.dirClose, 1)
    assert.equal(f.receipt.admin.client.database, 14); assert.equal(f.receipt.app.client.database, 14)
    assert.equal(f.receipt.admin.server.runId, runId); assert.equal(f.receipt.app.server.runId, runId)
    assert.equal(JSON.stringify(f.receipt).includes('must-not-be-recorded'), false)
    await f.hooks.beforeEach[0](); assert.equal(f.effects.scan, 1); assert.equal(f.effects.unlink, 1)
    await assert.rejects(f.hooks.tests[0](), /stops at the real Lua case boundary/)
    assert.equal(f.effects.seed, 1)
    for (const hook of f.hooks.afterEach) await hook(); assert.equal(f.effects.del, 1)
    await f.teardown(); assert.equal(f.effects.appDisconnect, 1); assert.equal(f.effects.adminQuit, 1)
  })
  it('teardown during a pending receipt prevents late suite admission and fixture effects', async () => {
    const f = fixture(); const gate = deferred(); f.recordGate = gate.promise; f.loadSuite()
    const start = f.hooks.beforeAll[0]()
    for (let step = 0; step < 100 && !f.effects.record; step++) await Promise.resolve()
    assert.equal(f.effects.record, 1)
    await f.teardown(); gate.resolve(); await assert.rejects(start, /after teardown/)
    await assert.rejects(f.hooks.beforeEach[0]())
    for (const hook of f.hooks.afterEach) await hook()
    await assert.rejects(f.hooks.tests[0](), /not completed admission/)
    noMutations(f); assert.equal(f.admin.isOpen, false); assert.equal(f.app.isOpen, false)
    assert.equal(f.effects.adminDisconnect, 1); assert.equal(f.effects.appDisconnect, 1)
  })
  it('settles and closes an app client acquired after teardown without admitting effects', async () => {
    const f = fixture(); const gate = deferred(); f.appAcquireGate = gate.promise; f.appLateEnvSync = true; f.loadSuite()
    const start = f.hooks.beforeAll[0]()
    // Attach the rejection observer before releasing the deferred acquisition.
    const rejected = assert.rejects(start, /after teardown/)
    for (let step = 0; step < 100 && !f.effects.appExecute; step++) await Promise.resolve()
    assert.equal(f.effects.appExecute, 1); assert.equal(f.app.isOpen, false)
    const end = f.teardown()
    for (let step = 0; step < 100 && !f.effects.appDisconnect; step++) await Promise.resolve()
    assert.equal(f.effects.appDisconnect, 1)
    gate.resolve(); await rejected; await end
    assert.equal(f.effects.appCommandDisconnect, 1); assert.equal(f.effects.appDisconnect, 2)
    assert.equal(f.app.isOpen, false); assert.equal(f.admin.isOpen, false); assert.equal(f.effects.record, 0)
    assert.equal(f.env.REDIS_URL, originalUrl); assert.equal(f.dynamicEnv.REDIS_URL, originalUrl)
    await assert.rejects(f.hooks.beforeEach[0]()); for (const hook of f.hooks.afterEach) await hook(); noMutations(f)
  })
  for (const [name, alter] of [
    ['missing allocation', (f: any) => { delete f.env.SA122_SETTINGS_REDIS_ALLOCATION }],
    ['malformed allocation JSON', (f: any) => { f.rawAllocation = '{' }],
    ['stale allocation', (f: any) => { f.allocation.createdAt = '2026-01-01T00:00:00.000Z' }],
    ['unknown allocation field', (f: any) => { f.allocation.allowCleanup = true }],
    ['symlink allocation', (f: any) => { f.regularFile = false }],
    ['wrong requested endpoint', (f: any) => { f.env.BATSHIT_REDIS_TEST_URL = 'redis://127.0.0.1:59124/15' }],
    ['actual worker DB15', (f: any) => { f.env.VITEST_POOL_ID = '0' }],
    ['unsafe receipt path', (f: any) => { f.allocation.receiptPath = '/other/settings-redis-admission.json' }]
  ] as const) {
    it(`refuses ${name} before app acquisition or mutations`, async () => {
      const f = fixture(); alter(f); f.loadSuite(); await refused(f)
      assert.equal(f.effects.appExecute, 0); assert.equal(f.effects.record, 0)
    })
  }
  for (const side of ['admin', 'app'] as const) {
    for (const [name, alter] of [
      ['wrong DB0', (client: any) => { client.connection.db = 0 }],
      ['wrong nonzero DB', (client: any) => { client.connection.db = 13 }],
      ['coerced DB string', (client: any) => { client.connection.db = '14' }],
      ['malformed CLIENT INFO', (client: any) => { client.connection = [] }],
      ['wrong endpoint', (client: any) => { client.connection.laddr = '127.0.0.1:59124' }],
      ['wrong run ID', (client: any) => { client.server = client.server.replace(runId, 'b'.repeat(40)) }],
      ['wrong Redis version', (client: any) => { client.server = client.server.replace('8.10.1', '8.0.0') }],
      ['malformed INFO', (client: any) => { client.server = {} }],
      ['duplicate INFO identity', (client: any) => { client.server += `run_id:${runId}\r\n` }],
      ['nonempty database', (client: any) => { client.size = 1 }],
      ['malformed JSON GET reply', (client: any) => { client.jsonReply = '[]' }]
    ] as const) {
      it(`refuses ${side} ${name} without cleanup, seed or DEL`, async () => {
        const f = fixture(); alter(f[side]); f.loadSuite(); await refused(f)
        assert.equal(f.effects.record, 0)
        if (side === 'admin') assert.equal(f.effects.appExecute, 0)
        else assert.equal(f.effects.appDisconnect, 1)
      })
    }
    it(`refuses ${side} read failure without cleanup, seed or DEL`, async () => {
      const f = fixture(); if (side === 'admin') f.adminReadFailure = true; else f.appReadFailure = true
      f.loadSuite(); await refused(f); assert.equal(f.effects.record, 0)
    })
  }
  it('refuses an app client substituted with the admin identity', async () => {
    const f = fixture(); f.app.connection.id = f.admin.connection.id; f.loadSuite(); await refused(f)
    assert.equal(f.effects.record, 0); assert.equal(f.effects.appDisconnect, 1)
  })
  for (const phase of ['open', 'write', 'sync', 'close', 'dirOpen', 'dirSync', 'dirClose'] as const) {
    it(`receipt ${phase} failure prevents all Redis effects and closes only owned clients`, async () => {
      const f = fixture(); f.receiptFailure = phase; f.loadSuite()
      await refused(f, error => { assert.equal(error, f.receiptErrors[phase]); return true })
      assert.equal(f.effects.appDisconnect, 1); assert.equal(f.effects.adminDisconnect, 1)
    })
  }
  for (const [phase, closeKind, closePhase] of [
    ['write', 'file', 'close'], ['sync', 'file', 'close'], ['dirSync', 'directory', 'dirClose']
  ] as const) {
    it(`retains receipt ${phase} and ${closePhase} errors without admitting Redis effects`, async () => {
      const f = fixture(); f.receiptFailure = phase; f.pairedCloseFailure = closeKind; f.loadSuite()
      await refused(f, error => {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.errors.length, 2)
        assert.equal(error.errors[0], f.receiptErrors[phase])
        assert.equal(error.errors[1], f.receiptErrors[closePhase])
        return true
      })
      assert.equal(f.effects.fileClose, 1)
      assert.equal(f.effects.dirClose, closeKind === 'directory' ? 1 : 0)
      assert.equal(f.effects.appDisconnect, 1); assert.equal(f.effects.adminDisconnect, 1)
    })
  }
  it('retains paired receipt errors and both outer cleanup errors without mutation authority', async () => {
    const f = fixture(); f.receiptFailure = 'write'; f.pairedCloseFailure = 'file'
    f.appCloseFailure = true; f.adminCloseFailure = true; f.loadSuite()
    await assert.rejects(f.hooks.beforeAll[0](), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      const admissionAndApp = error.errors[0]
      assert.ok(admissionAndApp instanceof AggregateError)
      assert.equal(admissionAndApp.errors.length, 2)
      const receipt = admissionAndApp.errors[0]
      assert.ok(receipt instanceof AggregateError)
      assert.equal(receipt.errors.length, 2)
      assert.equal(receipt.errors[0], f.receiptErrors.write)
      assert.equal(receipt.errors[1], f.receiptErrors.close)
      const appCleanup = admissionAndApp.errors[1]
      assert.ok(appCleanup instanceof AggregateError)
      assert.equal(appCleanup.errors.length, 1)
      assert.equal(appCleanup.errors[0], f.appCloseError)
      assert.equal(error.errors[1], f.adminCloseError)
      return true
    })
    await assert.rejects(f.hooks.beforeEach[0]()); for (const hook of f.hooks.afterEach) await hook()
    await assert.rejects(f.hooks.tests[0](), /not completed admission/)
    noMutations(f); assert.equal(f.effects.fileClose, 1); assert.equal(f.effects.dirClose, 0)
    await assert.rejects(f.teardown(), /app connection close failed/)
    assert.equal(f.env.REDIS_URL, originalUrl); assert.equal(f.dynamicEnv.REDIS_URL, originalUrl)
    assert.equal(f.admin.isOpen, false); assert.equal(f.app.isOpen, false)
  })
  it('retains admission and connection-close failures while withholding mutation authority', async () => {
    const f = fixture(); f.appReadFailure = true; f.appCloseFailure = true; f.loadSuite()
    await assert.rejects(f.hooks.beforeAll[0](), (error: any) => error instanceof AggregateError && error.errors.length === 2)
    await assert.rejects(f.hooks.beforeEach[0]()); for (const hook of f.hooks.afterEach) await hook(); noMutations(f)
    await assert.rejects(f.teardown(), /app connection close failed/)
    assert.equal(f.env.REDIS_URL, originalUrl); assert.equal(f.admin.isOpen, false)
  })
})
