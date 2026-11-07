// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Existing captured-hook pattern: execute actual owner bytes with no socket-
// capable dependency. This proves refusal ordering, not a live Redis result.
const requireNode = createRequire(import.meta.url)
const ownerSource = process.env.BL277_PRIMITIVE_SOURCE_REF
  ? execFileSync('git', ['show', `${process.env.BL277_PRIMITIVE_SOURCE_REF}:batshit-app/src/lib/server/tests/redisPrimitiveConformance.test.ts`], { encoding: 'utf8' })
  : readFileSync(fileURLToPath(new URL('./redisPrimitiveConformance.test.ts', import.meta.url)), 'utf8')
const compiled = ts.transpileModule(ownerSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
}, fileName: 'redisPrimitiveConformance.test.ts' }).outputText
const YAML = requireNode('yaml') as { parse(source: string): any }
const workflow = YAML.parse(readFileSync(fileURLToPath(new URL('../../../../../.github/workflows/ci.yml', import.meta.url)), 'utf8'))
const captureStep = workflow.jobs['app-redis'].steps.find((step: any) => step.name === 'bind primitive admin tests to this job-owned Redis')
const settingsCaptureStep = workflow.jobs['app-redis'].steps.find((step: any) => step.name === 'isolated Settings owners (actual CI Redis admission)')
const setupSource = readFileSync(fileURLToPath(new URL('../../test-utils/vitest-setup.ts', import.meta.url)), 'utf8')
const setupNormalization = setupSource.slice(setupSource.indexOf('if (!process.env.VITEST_REDIS_URL)'), setupSource.indexOf('\ntype ModelFactory'))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(ci = false) {
  const root = ci ? '/ci-temp' : '/owned-proof'
  const allocationPath = `${root}/redis-primitive-allocation.json`
  const serviceId = 'c'.repeat(64)
  const env: Record<string, string | undefined> = {
    VITEST_USE_REAL_REDIS: 'true', BATSHIT_REDIS_ADMIN_ALLOCATION: allocationPath,
    BATSHIT_REDIS_TEST_URL: `redis://127.0.0.1:${ci ? 6379 : 59123}/15`,
    VITEST_REDIS_URL: `redis://127.0.0.1:${ci ? 6379 : 59123}/15`,
    REDIS_URL: `redis://127.0.0.1:${ci ? 6379 : 59123}/15`,
    ...(ci ? { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '900001', GITHUB_RUN_ATTEMPT: '2',
      RUNNER_TEMP: root, BATSHIT_REDIS_CI_SERVICE_ID: serviceId } : {})
  }
  let allocation: any = {
    schemaVersion: 1, purpose: 'redis-primitive-conformance', allocationId: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date().toISOString(), host: '127.0.0.1', port: ci ? 6379 : 59123, database: 15,
    version: '8.10.1', runId: 'a'.repeat(40), directory: ci ? '/data' : `${root}/redis`,
    localAddress: ci ? '172.18.0.2:6379' : '127.0.0.1:59123', emptyAtAllocation: true,
    owner: ci ? { kind: 'github-actions-service', serviceId, githubRunId: '900001', githubRunAttempt: '2' } : {
      kind: 'local-supervised', pid: 45678, startIdentity: 'Fri Oct 23 09:00:00 2026', tty: 'ttys099', directoryDevice: '1', directoryInode: '2'
    }
  }
  const current = { version: '8.10.1', runId: 'a'.repeat(40), pid: 45678, db: 15,
    directory: allocation.directory, localAddress: allocation.localAddress, keyspace: '',
    startIdentity: 'Fri Oct 23 09:00:00 2026', tty: 'ttys099', inode: 2n,
    capabilities: [['json.get'], ['ft.search']] as any }
  const flags = { file: true, symlink: false, fileMode: 0o100600, uid: 1000, parentMode: 0o40700,
    fileAlias: false, connectFailure: false, readFailure: false, quitFailure: false, disconnectFailure: false,
    mutateAfterPersistence: false, mutateAfterConfig: false }
  const effects = { creates: 0, connects: 0, cleanup: 0, publish: 0, config: 0, rewrite: 0, rawMutations: 0, quit: 0, disconnect: 0 }
  const hooks = { before: [] as (() => Promise<void>)[], after: [] as (() => Promise<void>)[], tests: new Map<string, () => Promise<void>>() }
  let clientOptions: any
  let connectGate: Promise<void> | undefined
  const client = {
    isOpen: false, isReady: false,
    on() { return this },
    async connect() {
      effects.connects++
      this.isOpen = true // Actual nested @redis/client 5.11.0 sets this before socket creation.
      if (connectGate) await connectGate
      if (flags.connectFailure) throw new Error('connect failed')
      this.isReady = true
    },
    async clientInfo() { if (flags.readFailure) throw new Error('read failed'); return { id: 31, db: current.db, laddr: current.localAddress } },
    async info(section: string) {
      if (section === 'server') return `redis_version:${current.version}\nrun_id:${current.runId}\nprocess_id:${current.pid}\n`
      if (section === 'keyspace') return current.keyspace
      if (flags.mutateAfterPersistence) current.runId = 'b'.repeat(40)
      return ['loading', 'aof_enabled', 'aof_rewrites', 'aof_rewrite_in_progress', 'aof_last_write_status',
        'aof_last_bgrewrite_status', 'rdb_last_bgsave_status', 'rdb_bgsave_in_progress'].map(name => `${name}:0`).join('\n')
    },
    async sendCommand(command: string[]) {
      if (JSON.stringify(command) === JSON.stringify(['CONFIG', 'GET', 'dir'])) return ['dir', current.directory]
      if (JSON.stringify(command) === JSON.stringify(['COMMAND', 'INFO', 'JSON.GET', 'FT.SEARCH'])) return current.capabilities
      effects.rawMutations++; throw new Error('Unexpected raw mutation')
    },
    async publish() { effects.publish++; return 0 },
    async ping() { return 'PONG' },
    async configSet() { effects.config++; if (flags.mutateAfterConfig) current.runId = 'b'.repeat(40); return 'OK' },
    async bgRewriteAof() { effects.rewrite++; return 'Background append only file rewriting started' },
    async quit() { effects.quit++; this.isOpen = false; if (flags.quitFailure) throw new Error('quit failed'); this.isReady = false },
    async disconnect() { effects.disconnect++; if (flags.disconnectFailure) throw new Error('disconnect failed'); this.isOpen = this.isReady = false }
  }
  const fakeFs = {
    async lstat(path: string) {
      const file = path === allocationPath
      return { isFile: () => file && flags.file, isDirectory: () => !file, isSymbolicLink: () => file && flags.symlink,
        mode: BigInt(file ? flags.fileMode : flags.parentMode), uid: BigInt(flags.uid), size: 1024n,
        dev: 1n, ino: path === current.directory ? current.inode : 3n }
    },
    async realpath(path: string) { return path === allocationPath && flags.fileAlias ? `${path}-alias` : path },
    async readFile() { return JSON.stringify(allocation) }
  }
  const fakeRequire = (name: string) => {
    if (name === 'vitest') return {
      beforeAll: (callback: () => Promise<void>) => hooks.before.push(callback),
      afterAll: (callback: () => Promise<void>) => hooks.after.push(callback),
      describe: { skipIf: (skip: boolean) => (_name: string, callback: () => void) => { if (!skip) callback() } },
      it: (name: string, callback: () => Promise<void>) => hooks.tests.set(name, callback), expect,
      vi: { mock() {} }
    }
    if (name === 'redis') return { createClient: (options: any) => { effects.creates++; clientOptions = options; return client } }
    if (name === '$lib/test-utils/redis-memory') return { clearRedisTestDatabase: async () => { effects.cleanup++ } }
    if (name === '$lib/server/redisRuntimePorts') return { BATSHIT_RUNTIME_REDIS_PORTS: new Set([6379, 5639, 5659, 6380, 5649]) }
    if (name === 'node:fs/promises') return fakeFs
    if (name === 'node:path') return requireNode(name)
    if (name === 'node:child_process') return { execFileSync: (_file: string, args: string[]) => args.at(-1) === 'tty=' ? current.tty : current.startIdentity }
    throw new Error(`No socket-capable dependency admitted: ${name}`)
  }
  const fakeProcess = { env, platform: ci ? 'linux' : 'darwin', getuid: () => 1000 }
  vm.runInNewContext(compiled, { require: fakeRequire, exports: {}, process: fakeProcess,
    URL, Date, Error, AggregateError, Promise, Buffer }, { filename: 'redisPrimitiveConformance.test.ts' })
  return { env, current, flags, effects, hooks, client, process: fakeProcess,
    get allocation() { return allocation }, set allocation(value: any) { allocation = value },
    get options() { return clientOptions }, set connectGate(value: Promise<void> | undefined) { connectGate = value },
    before: () => hooks.before[0](), after: () => hooks.after[0](),
    normalize: () => vm.runInNewContext(setupNormalization, { process: fakeProcess }),
    admin: () => hooks.tests.get('supports pub/sub and the admin reads the supervisor and upload service depend on')!(),
    mutations: () => effects.cleanup + effects.publish + effects.config + effects.rewrite + effects.rawMutations }
}

describe('BL-277 actual primitive-owner admission hooks, no Redis socket', () => {
  const refusals: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['missing allocation', f => { delete f.env.BATSHIT_REDIS_ADMIN_ALLOCATION }],
    ['relative allocation', f => { f.env.BATSHIT_REDIS_ADMIN_ALLOCATION = 'redis-primitive-allocation.json' }],
    ['symlink', f => { f.flags.symlink = true }], ['other UID', f => { f.flags.uid = 2000 }],
    ['public allocation', f => { f.flags.fileMode = 0o100644 }], ['aliased allocation', f => { f.flags.fileAlias = true }],
    ['public local directory', f => { f.flags.parentMode = 0o40755 }],
    ['wrong purpose', f => { f.allocation.purpose = 'anything-else' }],
    ['stale local allocation', f => { f.allocation.createdAt = new Date(Date.now() - 31 * 60_000).toISOString() }],
    ['future allocation', f => { f.allocation.createdAt = new Date(Date.now() + 60_000).toISOString() }],
    ['normal runtime port', f => { f.allocation.port = 6379 }],
    ['unowned low port', f => { f.allocation.port = 5769 }],
    ['unsupported local platform', f => { f.process.platform = 'win32' }],
    ['DB0 allocation', f => { f.allocation.database = 0 }],
    ['missing effective URL', f => { delete f.env.VITEST_REDIS_URL }],
    ['convenience URL mismatch', f => { f.env.VITEST_REDIS_URL = 'redis://127.0.0.1:6379/15' }],
    ['effective DB0 URL', f => { f.env.REDIS_URL = 'redis://127.0.0.1:59123/0' }],
    ['credential URL', f => { f.env.REDIS_URL = 'redis://name:password@127.0.0.1:59123/15' }],
    ['actual DB0', f => { f.current.db = 0 }], ['wrong run ID', f => { f.current.runId = 'b'.repeat(40) }],
    ['wrong version', f => { f.current.version = '8.9.0' }], ['wrong directory', f => { f.current.directory = '/normal/redis' }],
    ['wrong local address', f => { f.current.localAddress = '127.0.0.1:6379' }],
    ['missing JSON', f => { f.current.capabilities = [null, ['ft.search']] }],
    ['malformed capability', f => { f.current.capabilities = [[], []] }],
    ['wrong process', f => { f.current.pid++ }], ['changed start', f => { f.current.startIdentity = 'other process' }],
    ['changed TTY', f => { f.current.tty = '??' }], ['changed directory inode', f => { f.current.inode++ }],
    ['shared data in DB0', f => { f.current.keyspace = 'db0:keys=1,expires=0\n' }],
    ['shared data in another DB', f => { f.current.keyspace = 'db14:keys=1,expires=0\n' }],
    ['failed identity read', f => { f.flags.readFailure = true }], ['failed connect', f => { f.flags.connectFailure = true }]
  ]
  it.each(refusals)('%s never cleans, seeds, publishes or invokes admin work', async (_name, change) => {
    const f = fixture(); change(f)
    await expect(f.before()).rejects.toThrow()
    await expect(f.after()).resolves.toBeUndefined()
    expect(f.mutations()).toBe(0)
    expect(f.client.isOpen).toBe(false)
  })
  it('admitted local owner uses one fixed DB15 client with no offline queue or reconnect', async () => {
    const f = fixture(); await f.before()
    expect(f.effects.cleanup).toBe(1)
    expect(f.options).toMatchObject({ database: 15, disableOfflineQueue: true, socket: { reconnectStrategy: false } })
    await f.after(); expect(f.effects.cleanup).toBe(2); expect(f.client.isOpen).toBe(false)
    expect(f.effects.quit).toBe(0); expect(f.effects.disconnect).toBe(1)
  })
  it.each([undefined, 'redis://127.0.0.1:6379/0'])('actual setup normalizes original REDIS_URL %s to the explicit owned effective DB15', async original => {
    const f = fixture(); f.env.REDIS_URL = original; f.normalize()
    expect(f.env.REDIS_URL).toBe(f.env.VITEST_REDIS_URL)
    await f.before(); await f.after(); expect(f.effects.cleanup).toBe(2)
  })
  it.each(['BATSHIT_REDIS_TEST_URL', 'VITEST_REDIS_URL', 'wrong-concrete-REDIS_URL'])('actual setup cannot supply missing/mismatched owned input %s', async name => {
    const f = fixture()
    if (name === 'wrong-concrete-REDIS_URL') f.env.REDIS_URL = 'redis://127.0.0.1:6379/15'
    else delete f.env[name]
    f.normalize()
    await expect(f.before()).rejects.toThrow(); await f.after(); expect(f.mutations()).toBe(0)
  })
  it('the same CI job-owned service may contain earlier same-job fixtures', async () => {
    const f = fixture(true); f.current.keyspace = 'db14:keys=3,expires=0\n'
    await f.before(); await f.after(); expect(f.effects.cleanup).toBe(2)
  })
  it.each(['GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'BATSHIT_REDIS_CI_SERVICE_ID', 'RUNNER_TEMP'])('CI cannot borrow a missing/other %s', async name => {
    const f = fixture(true); f.env[name] = 'not-this-job'
    await expect(f.before()).rejects.toThrow(); await f.after(); expect(f.mutations()).toBe(0)
  })
  it('an old CI run/attempt is stale even with a matching endpoint and CI=true', async () => {
    const f = fixture(true); f.allocation.owner.githubRunAttempt = '1'
    await expect(f.before()).rejects.toThrow(); await f.after(); expect(f.mutations()).toBe(0)
  })
  it('teardown before late connect/admission permits no cleanup or fixture action', async () => {
    const f = fixture(), gate = deferred(); f.connectGate = gate.promise
    const pending = f.before().then(() => undefined, error => error)
    while (!f.effects.connects) await Promise.resolve()
    const ending = f.after()
    await Promise.resolve()
    expect(f.client.isOpen).toBe(true); expect(f.effects.disconnect).toBe(0); expect(f.mutations()).toBe(0)
    gate.resolve()
    expect(await pending).toBeInstanceOf(Error)
    await ending
    expect(f.mutations()).toBe(0); expect(f.client.isOpen).toBe(false); expect(f.client.isReady).toBe(false)
    expect(f.effects.disconnect).toBe(1); expect(f.effects.quit).toBe(0)
  })
  it('a changed server before the admin case cannot publish, configure, rewrite or clean it', async () => {
    const f = fixture(); await f.before(); f.effects.cleanup = 0; f.current.runId = 'b'.repeat(40)
    await expect(f.admin()).rejects.toThrow(); await expect(f.after()).rejects.toThrow()
    expect(f.mutations()).toBe(0); expect(f.client.isOpen).toBe(false)
  })
  it('rechecks immediately before CONFIG and again before BGREWRITE', async () => {
    const f = fixture(); await f.before(); f.flags.mutateAfterPersistence = true
    await expect(f.admin()).rejects.toThrow(); expect(f.effects.config).toBe(0); expect(f.effects.rewrite).toBe(0)
    await expect(f.after()).rejects.toThrow(); expect(f.client.isOpen).toBe(false)
    const g = fixture(); await g.before(); g.flags.mutateAfterConfig = true
    await expect(g.admin()).rejects.toThrow(); expect(g.effects.config).toBe(1); expect(g.effects.rewrite).toBe(0)
    await expect(g.after()).rejects.toThrow(); expect(g.client.isOpen).toBe(false)
  })
  it('refusal directly closes without the QUIT early-closed trap', async () => {
    const f = fixture(); f.flags.readFailure = true; f.flags.quitFailure = true
    await expect(f.before()).rejects.toThrow('read failed')
    await f.after(); expect(f.effects.disconnect).toBe(1); expect(f.effects.quit).toBe(0)
    expect(f.mutations()).toBe(0); expect(f.client.isReady).toBe(false)
  })
  it('failed direct closure remains visible together with the admission failure', async () => {
    const f = fixture(); f.flags.readFailure = true; f.flags.disconnectFailure = true
    await expect(f.before()).rejects.toThrow(/admission and close/)
    await expect(f.after()).rejects.toThrow('disconnect failed')
    expect(f.effects.disconnect).toBe(1); expect(f.effects.quit).toBe(0); expect(f.mutations()).toBe(0)
  })
})

describe('actual CI capture is read-only and tied to the job service', () => {
  async function capture(change?: (state: any) => void) {
    const serviceId = 'c'.repeat(64), effects = { connects: 0, allocations: 0, envWrites: 0, mutations: 0, quit: 0, disconnect: 0 }
    const env: any = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '900001', GITHUB_RUN_ATTEMPT: '2',
      RUNNER_TEMP: '/ci-temp', GITHUB_ENV: '/ci-env', BATSHIT_REDIS_CI_SERVICE_ID: serviceId }
    const state = { env, container: { Id: serviceId, State: { Running: true }, Config: { Image: workflow.jobs['app-redis'].services.redis.image },
      NetworkSettings: { Ports: { '6379/tcp': [{ HostIp: '0.0.0.0', HostPort: '6379' }] },
        Networks: { job: { IPAddress: '172.18.0.2' } } } }, keyspace: '', runId: 'a'.repeat(40),
      localAddress: '172.18.0.2:6379', disconnectFailure: false }
    change?.(state)
    const client = { isOpen: false, isReady: false, on() {}, async connect() { effects.connects++; this.isOpen = this.isReady = true },
      async info(section: string) { return section === 'server' ? `redis_version:8.10.1\nrun_id:${state.runId}\nprocess_id:1\n` : state.keyspace },
      async clientInfo() { return { db: 15, laddr: state.localAddress } },
      async sendCommand(command: string[]) {
        if (JSON.stringify(command) === JSON.stringify(['CONFIG', 'GET', 'dir'])) return ['dir', '/data']
        if (JSON.stringify(command) === JSON.stringify(['COMMAND', 'INFO', 'JSON.GET', 'FT.SEARCH'])) return [['json.get'], ['ft.search']]
        effects.mutations++; throw new Error('CI capture attempted a raw mutation')
      },
      async quit() { effects.quit++; this.isOpen = false; throw new Error('QUIT can leave isReady true') },
      async disconnect() { effects.disconnect++; if (state.disconnectFailure) throw new Error('disconnect failed'); this.isOpen = this.isReady = false } }
    let allocation: any, environmentText = ''
    const require = (name: string) => {
      if (name === 'redis') return { createClient: () => client }
      if (name === 'node:fs/promises') return { realpath: async (path: string) => path,
        writeFile: async (_path: string, raw: string, options: any) => { effects.allocations++; expect(options).toEqual({ flag: 'wx', mode: 0o600 }); allocation = JSON.parse(raw) },
        appendFile: async (_path: string, raw: string) => { effects.envWrites++; environmentText = raw } }
      if (name === 'node:child_process') return { execFileSync: (file: string, args: string[]) => { expect(file).toBe('docker'); expect(args).toEqual(['inspect', serviceId]); return JSON.stringify([state.container]) } }
      if (name === 'node:net') return { isIP: requireNode('node:net').isIP }
      if (['node:assert/strict', 'node:path', 'node:crypto'].includes(name)) return requireNode(name)
      throw new Error(`No real process/socket allowed: ${name}`)
    }
    expect(captureStep.env.BATSHIT_REDIS_CI_SERVICE_ID).toBe('${{ job.services.redis.id }}')
    const code = captureStep.run.split("node <<'NODE'\n")[1].split('\nNODE')[0]
    const fakeProcess = { env, exitCode: undefined as number | undefined }
    await vm.runInNewContext(code, { require, process: fakeProcess, console: { error() {} } })
    return { effects, allocation, environmentText, exitCode: fakeProcess.exitCode, client }
  }
  it('captures only a fresh actual job-owned container and publishes all explicit URLs', async () => {
    const result = await capture()
    expect(result.exitCode).toBeUndefined(); expect(result.effects).toMatchObject({ allocations: 1, envWrites: 1, mutations: 0 })
    expect(result.allocation).toMatchObject({ database: 15, emptyAtAllocation: true,
      owner: { kind: 'github-actions-service', serviceId: 'c'.repeat(64), githubRunId: '900001', githubRunAttempt: '2' } })
    for (const name of ['BATSHIT_REDIS_TEST_URL', 'VITEST_REDIS_URL', 'REDIS_URL']) {
      expect(result.environmentText.split('\n')).toContain(`${name}=redis://127.0.0.1:6379/15`)
    }
    expect(result.environmentText).toContain('BATSHIT_REDIS_ADMIN_ALLOCATION=/ci-temp/redis-primitive-allocation.json')
    expect(result.client.isOpen).toBe(false); expect(result.client.isReady).toBe(false)
    expect(result.effects).toMatchObject({ quit: 0, disconnect: 1 })
  })
  it.each([
    (s: any) => { s.env.GITHUB_ACTIONS = 'false' }, (s: any) => { s.container.Id = 'd'.repeat(64) },
    (s: any) => { s.container.State.Running = false }, (s: any) => { s.container.Config.Image = 'other' },
    (s: any) => { s.container.NetworkSettings.Ports['6379/tcp'] = [{ HostPort: '6380' }] },
    (s: any) => { s.container.NetworkSettings.Ports['6379/tcp'][0].HostIp = '192.0.2.1' },
    (s: any) => { s.container.NetworkSettings.Networks.job.IPAddress = '' },
    (s: any) => { s.localAddress = '172.18.0.3:6379' },
    (s: any) => { s.keyspace = 'db0:keys=1,expires=0\n' }, (s: any) => { s.runId = 'invalid' }
  ])('does not publish an allocation for unbound/shared service %#', async change => {
    const result = await capture(change)
    expect(result.exitCode).toBe(1); expect(result.effects).toMatchObject({ allocations: 0, envWrites: 0, mutations: 0 })
    expect(result.client.isOpen).toBe(false)
  })
  it('failed capture-client closure cannot publish an allocation or environment', async () => {
    const result = await capture(s => { s.disconnectFailure = true })
    expect(result.exitCode).toBe(1); expect(result.effects).toMatchObject({ allocations: 0, envWrites: 0, mutations: 0, quit: 0, disconnect: 1 })
  })
})

it.runIf(process.platform !== 'win32')('test:redis preserves explicit URLs and retains ordinary non-admin defaults', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf8'))
  const script: string = pkg.scripts['test:redis']
  const suffix = ' vitest run --pool=threads --maxWorkers=1'
  expect(script.endsWith(suffix)).toBe(true)
  const prefix = script.slice(0, -suffix.length)
  for (const explicit of [undefined, 'redis://127.0.0.1:59123/15', 'redis://user:literal$@127.0.0.1:59123/15?query=a&more=b']) {
    const env = { ...process.env, BL277_NODE_EXECUTABLE: process.execPath }
    if (explicit) env.VITEST_REDIS_URL = explicit
    else delete env.VITEST_REDIS_URL
    const actual = execFileSync('/bin/sh', ['-c', `${prefix} "$BL277_NODE_EXECUTABLE" -p 'process.env.VITEST_REDIS_URL'`], { env, encoding: 'utf8' }).trim()
    expect(actual).toBe(explicit ?? 'redis://127.0.0.1:6379/15')
  }
})


describe('actual per-file CI Settings capture before fresh admission', () => {
  async function captureSettings(change?: (state: any) => void) {
    const serviceId = 'c'.repeat(64), runId = 'a'.repeat(40)
    const env: any = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '900001', GITHUB_RUN_ATTEMPT: '2',
      BATSHIT_REDIS_CI_SERVICE_ID: serviceId, BATSHIT_REDIS_ADMIN_ALLOCATION: '/ci-temp/redis-primitive-allocation.json',
      SA122_SETTINGS_REDIS_ALLOCATION: '/ci-temp/settings-owner/settings-redis-allocation.json' }
    const original = { host: '127.0.0.1', port: 6379, runId, directory: '/data', localAddress: '172.18.0.2:6379',
      owner: { kind: 'github-actions-service', serviceId, githubRunId: '900001', githubRunAttempt: '2' } }
    const state = { env, original, db: 14, version: '8.10.1', runId, directory: '/data',
      localAddress: '172.18.0.2:6379', keys: ['prior-owner:fixture'], disconnectFailure: false, existingFile: false }
    change?.(state)
    const effects = { connects: 0, scan: 0, unlink: 0, allocations: 0, disconnect: 0, unexpected: 0 }
    const client = { isOpen: false, isReady: false, on() {},
      async connect() { effects.connects++; this.isOpen = this.isReady = true },
      async info(section: string) {
        expect(section).toBe('server')
        return `redis_version:${state.version}\nrun_id:${state.runId}\nprocess_id:1\n`
      },
      async clientInfo() { return { db: state.db, laddr: state.localAddress } },
      async configGet(name: string) { expect(name).toBe('dir'); return { dir: state.directory } },
      async scan() { effects.scan++; return { cursor: '0', keys: state.keys } },
      async unlink(keys: string[]) { effects.unlink++; expect(keys).toEqual(state.keys); state.keys = []; return keys.length },
      async dbSize() { return state.keys.length },
      async sendCommand(command: string[]) {
        if (JSON.stringify(command) === JSON.stringify(['JSON.GET', 'sa122:settings:admission:missing', '$'])) return null
        effects.unexpected++; throw new Error('Unexpected Settings capture command')
      },
      async disconnect() { effects.disconnect++; if (state.disconnectFailure) throw new Error('disconnect failed'); this.isOpen = this.isReady = false }
    }
    let allocation: any
    const require = (name: string) => {
      if (name === 'redis') return { createClient: (config: any) => {
        expect(config).toEqual({ url: 'redis://127.0.0.1:6379/14', database: 14,
          disableOfflineQueue: true, socket: { reconnectStrategy: false } })
        return client
      } }
      if (name === 'node:fs/promises') return {
        readFile: async (path: string) => { expect(path).toBe(env.BATSHIT_REDIS_ADMIN_ALLOCATION); return JSON.stringify(original) },
        writeFile: async (path: string, raw: string, options: any) => {
          expect(path).toBe(env.SA122_SETTINGS_REDIS_ALLOCATION); expect(options).toEqual({ flag: 'wx', mode: 0o600 })
          expect(client.isOpen).toBe(false); expect(client.isReady).toBe(false)
          if (state.existingFile) throw new Error('allocation already exists')
          effects.allocations++; allocation = JSON.parse(raw)
        }
      }
      if (['node:assert/strict', 'node:path', 'node:crypto'].includes(name)) return requireNode(name)
      throw new Error(`No real process/socket allowed: ${name}`)
    }
    const code = settingsCaptureStep.run.split("node <<'NODE'\n")[1].split('\nNODE')[0]
    const fakeProcess = { env, exitCode: undefined as number | undefined }
    await vm.runInNewContext(code, { require, process: fakeProcess, console: { error() {} } })
    return { effects, allocation, exitCode: fakeProcess.exitCode, client }
  }

  it('keeps every strict Settings owner in a separate actual test invocation', () => {
    const general = workflow.jobs['app-redis'].steps.find((step: any) => step.name === 'vitest (real Redis 8, DB15)').run
    for (const path of ['src/lib/server/services/appActions/settings/management.redis.test.ts',
      'src/lib/server/services/__tests__/approvalAnswerRecord.test.ts',
      'src/lib/components/settings/panels/AgentSettingsPanel.agentWriteRefresh.test.ts']) {
      expect(settingsCaptureStep.run.split(path)).toHaveLength(2)
      expect(general.includes(path)).toBe(false)
    }
    expect(settingsCaptureStep.run).toContain('npm run test:redis -- "$settings_test"')
  })
  it('retires only prior owned DB14 fixtures and publishes one fresh allocation after direct close', async () => {
    const result = await captureSettings()
    expect(result.exitCode).toBeUndefined()
    expect(result.effects).toEqual({ connects: 1, scan: 1, unlink: 1, allocations: 1, disconnect: 1, unexpected: 0 })
    expect(result.allocation).toMatchObject({ schemaVersion: 2, host: '127.0.0.1', port: 6379, database: 14,
      runId: 'a'.repeat(40), ciOwner: { kind: 'github-actions-service', serviceId: 'c'.repeat(64),
        githubRunId: '900001', githubRunAttempt: '2', localAddress: '172.18.0.2:6379' } })
  })
  for (const [name, alter] of [
    ['wrong service', (state: any) => { state.env.BATSHIT_REDIS_CI_SERVICE_ID = 'd'.repeat(64) }],
    ['wrong run', (state: any) => { state.env.GITHUB_RUN_ID = '900002' }],
    ['wrong attempt', (state: any) => { state.env.GITHUB_RUN_ATTEMPT = '3' }],
    ['not Actions', (state: any) => { delete state.env.GITHUB_ACTIONS }],
    ['wrong actual DB', (state: any) => { state.db = 15 }],
    ['wrong version', (state: any) => { state.version = '8.0.0' }],
    ['wrong run identity', (state: any) => { state.runId = 'b'.repeat(40) }],
    ['wrong container address', (state: any) => { state.localAddress = '172.18.0.9:6379' }],
    ['wrong data root', (state: any) => { state.directory = '/foreign' }]
  ] as const) {
    it(`refuses ${name} before fixture cleanup or new allocation`, async () => {
      const result = await captureSettings(alter)
      expect(result.exitCode).toBe(1)
      expect(result.effects.scan).toBe(0); expect(result.effects.unlink).toBe(0); expect(result.effects.allocations).toBe(0)
      expect(result.client.isOpen).toBe(false); expect(result.client.isReady).toBe(false)
    })
  }
  it('retains a close failure and publishes no allocation', async () => {
    const result = await captureSettings(state => { state.disconnectFailure = true })
    expect(result.exitCode).toBe(1); expect(result.effects.allocations).toBe(0)
    expect(result.effects.disconnect).toBe(1)
  })
  it('never overwrites an existing allocation', async () => {
    const result = await captureSettings(state => { state.existingFile = true })
    expect(result.exitCode).toBe(1); expect(result.effects.allocations).toBe(0)
    expect(result.client.isOpen).toBe(false); expect(result.client.isReady).toBe(false)
  })
})
