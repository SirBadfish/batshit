import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertMacCustodyPathAllowed } from '../macCustodyPaths'
import { sbxCreateArgs } from '../dockerSandboxSbx'

afterEach(() => vi.unstubAllEnvs())

describe('Mac custody read and mount admission', () => {
  it('refuses the config, parents, alias files and alias mounts; allows siblings', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'sa130-custody-'))
    const root = await realpath(temp)
    try {
      const data = path.join(root, 'mac-data')
      const config = path.join(data, 'config')
      const project = path.join(root, 'project')
      await mkdir(config, { recursive: true })
      await mkdir(project)
      await writeFile(path.join(config, 'runtime.env'), 'synthetic-secret-sentinel')
      await symlink(config, path.join(project, 'alias'))
      await symlink(path.join(config, 'runtime.env'), path.join(project, 'file-alias'))
      const capitalConfig = path.join(data, 'CONFIG')
      const caseAliasReadable = await readFile(path.join(capitalConfig, 'RUNTIME.ENV'), 'utf8').then(() => true, () => false)
      if (caseAliasReadable) await symlink(path.join(capitalConfig, 'RUNTIME.ENV'), path.join(project, 'case-alias'))
      vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app')
      vi.stubEnv('BATSHIT_CONTAINERIZED', '0')
      vi.stubEnv('BATSHIT_MAC_DATA_DIR', data)
      for (const candidate of [config, data, root, path.join(project, 'alias'), path.join(project, 'file-alias'), ...(caseAliasReadable ? [capitalConfig, path.join(capitalConfig, 'RUNTIME.ENV'), path.join(project, 'case-alias')] : [])]) {
        expect(() => assertMacCustodyPathAllowed(candidate)).toThrow(/credential storage/)
        expect(() => sbxCreateArgs({ sandboxName: 'fixture', workspaceRoot: candidate })).toThrow(/protected runtime/)
      }
      expect(() => assertMacCustodyPathAllowed(project)).not.toThrow()
      expect(sbxCreateArgs({ sandboxName: 'fixture', workspaceRoot: project })).toContain(project)
      expect(() => sbxCreateArgs({ sandboxName: 'fixture', workspaceRoot: project, extraWorkspaces: [data] })).toThrow(/protected runtime/)
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
})
