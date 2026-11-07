import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, link, unlink, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertMacCustodyPathAllowed, macCustodyRoots, credentialCustodyRoots } from '../macCustodyPaths'
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
  it('protects Pinokio vault/key aliases, refuses ambiguous hardlink mounts, and preserves ordinary hardlinks', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sa130-pinokio-custody-')))
    try {
      const runtime = path.join(root, 'pinokio', 'runtime'), vault = path.join(runtime, 'chatgpt-plan'), project = path.join(root, 'project')
      await mkdir(vault, { recursive: true }); await mkdir(project)
      await writeFile(path.join(root, 'pinokio', 'batshit.env'), 'SYNTHETIC_KEY_SENTINEL')
      await writeFile(path.join(vault, 'credentials.sqlite'), 'SYNTHETIC_VAULT_SENTINEL')
      await writeFile(path.join(project, 'ordinary'), 'ordinary')
      await link(path.join(project, 'ordinary'), path.join(project, 'ordinary-alias'))
      vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'pinokio'); vi.stubEnv('BATSHIT_CONTAINERIZED', '0'); vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
      vi.stubEnv('BATSHIT_RUNTIME_DATA_DIR', runtime)
      expect(macCustodyRoots()).toEqual([]) // Local AI's first Mac config root stays separate.
      for (const protectedPath of [vault, runtime, path.join(root, 'pinokio', 'batshit.env')]) expect(() => assertMacCustodyPathAllowed(protectedPath)).toThrow(/credential storage/)
      expect(() => assertMacCustodyPathAllowed(path.join(project, 'ordinary-alias'))).not.toThrow()
      expect(sbxCreateArgs({ sandboxName: 'fixture', workspaceRoot: project })).toContain(project)
      for (const source of [path.join(root, 'pinokio', 'batshit.env'), path.join(vault, 'credentials.sqlite')]) {
        const alias = path.join(project, 'secret-alias')
        await link(source, alias)
        expect(() => assertMacCustodyPathAllowed(alias)).toThrow(/credential storage/)
        expect(() => sbxCreateArgs({ sandboxName: 'fixture', workspaceRoot: project })).toThrow(/hardlink alias/)
        await unlink(alias)
      }
      expect(sbxCreateArgs({ sandboxName: 'fixture', workspaceRoot: project })).toContain(project)
      // Unexpected metadata failure in a known candidate is not permission to
      // read a hardlinked file or grant a new mount.
      await writeFile(path.join(vault, 'custody'), 'synthetic malformed custody entry')
      expect(() => assertMacCustodyPathAllowed(path.join(project, 'ordinary-alias'))).toThrow(/metadata could not be checked/)
      expect(() => sbxCreateArgs({ sandboxName: 'fixture', workspaceRoot: project })).toThrow(/metadata could not be checked/)
      await unlink(path.join(vault, 'custody'))
      vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app'); vi.stubEnv('BATSHIT_MAC_DATA_DIR', path.join(root, 'mac'))
      expect(macCustodyRoots()[0]).toBe(path.join(root, 'mac', 'config'))
      vi.stubEnv('BATSHIT_CONTAINERIZED', '1')
      expect(credentialCustodyRoots()).toContain('/var/lib/batshit-plan')
      expect(() => assertMacCustodyPathAllowed('/var/lib/batshit-plan/custody/vault.key')).toThrow(/credential storage/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
