const assert = require('node:assert/strict')
const { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
// Keep workstation dotenv/config out of this real filesystem boundary proof.
jest.mock('../config', () => ({ logLevel: 'error' }))


test('real helper file reads deny caller-selected custody roots and symlink aliases', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sa130-read-'))
  const root = await realpath(temp)
  const previous = Object.fromEntries(['BATSHIT_RUNTIME_OWNER', 'BATSHIT_CONTAINERIZED', 'BATSHIT_MAC_DATA_DIR', 'BATSHIT_SERVER_LOG_DIR'].map(key => [key, process.env[key]]))
  // Exercise real reads without loading the workstation dotenv/config or Redis.
  process.env.BATSHIT_SERVER_LOG_DIR = path.join(root, 'logs')
  const BuiltInService = require('../services/builtInService.js')
  try {
    const data = path.join(root, 'data')
    const config = path.join(data, 'config')
    const project = path.join(root, 'project')
    await mkdir(config, { recursive: true }); await mkdir(project)
    await writeFile(path.join(config, 'runtime.env'), 'synthetic-secret-sentinel')
    await writeFile(path.join(project, 'normal.txt'), 'ordinary project content')
    await symlink(path.join(config, 'runtime.env'), path.join(project, 'alias.txt'))
    const capitalConfig = path.join(data, 'CONFIG')
    // Prove this is a readable alias on the actual Mac volume, not a lexical
    // string comparison test. Case-sensitive platforms have no such alias.
    const caseAliasReadable = await readFile(path.join(capitalConfig, 'RUNTIME.ENV'), 'utf8').then(value => value === 'synthetic-secret-sentinel', () => false)
    if (caseAliasReadable) await symlink(path.join(capitalConfig, 'RUNTIME.ENV'), path.join(project, 'case-alias.txt'))
    process.env.BATSHIT_RUNTIME_OWNER = 'mac-app'
    process.env.BATSHIT_CONTAINERIZED = '0'
    process.env.BATSHIT_MAC_DATA_DIR = data
    const service = new BuiltInService()
    const reads = [[config, 'runtime.env'], [data, 'config/runtime.env'], [project, 'alias.txt']]
    if (caseAliasReadable) reads.push([capitalConfig, 'RUNTIME.ENV'], [data, 'CONFIG/RUNTIME.ENV'], [project, 'case-alias.txt'])
    for (const [selectedRoot, filePath] of reads) {
      const result = await service.readFile(selectedRoot, { filePath })
      assert.equal(result.success, false)
      assert.match(result.error, /credential storage/)
      assert.equal(JSON.stringify(result).includes('synthetic-secret-sentinel'), false)
    }
    assert.equal((await service.readFile(project, { filePath: 'normal.txt' })).content, 'ordinary project content')
  } finally {
    for (const key of ['BATSHIT_RUNTIME_OWNER', 'BATSHIT_CONTAINERIZED', 'BATSHIT_MAC_DATA_DIR', 'BATSHIT_SERVER_LOG_DIR']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
    }
    await rm(temp, { recursive: true, force: true })
  }
})
