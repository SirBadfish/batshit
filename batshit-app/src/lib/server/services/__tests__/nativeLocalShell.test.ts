import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { NATIVE_BASH_SHELL_GUIDANCE, nativeToolService } from '../nativeTools'
import * as localShell from '../localCommandShell'

// Real local processes; the default lane only fakes Redis/providers, never these shells.
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-local-shell-'))
  roots.push(root)
  return root
}
function run(command: string, root: string, accessMode: 'dangerous' | 'plan' = 'dangerous', extra = {}) {
  return nativeToolService.nativeBashExecute({
    command, workspaceRoot: root, backend: 'local', accessMode, requireApproval: false, ...extra
  })
}

it('selects the installed system shell and reports the interpreter that actually ran', async () => {
  const root = await workspace()
  const expected = await localShell.resolveLocalCommandShell()
  const result = await run('printf "%s" "${ZSH_VERSION:-${BASH_VERSION:-missing}}"', root)
  expect(result).toMatchObject({ success: true, shell: expected, exitCode: 0, cwd: await realpath(root) })
  expect(result.stdout).toMatch(/^\d+\./)
  expect(result.command).toContain(`${expected} -lc `)
})

for (const shell of ['/bin/zsh', '/bin/bash'].filter(existsSync)) {
  describe(`actual ${shell}`, () => {
    it('keeps Plan inspections and literal Markdown writes working', async () => {
      vi.spyOn(localShell, 'resolveLocalCommandShell').mockResolvedValue(shell)
      const root = await workspace()
      const write = await run('printf "safe\\n" > notes.md', root, 'plan')
      expect(write).toMatchObject({ success: true, shell })
      expect(await readFile(path.join(root, 'notes.md'), 'utf8')).toBe('safe\n')
      const read = await run('cat notes.md', root, 'plan')
      expect(read).toMatchObject({ success: true, shell, stdout: 'safe\n' })
    })

    it.each([
      'printf bad > forbidden.ts',
      'printf bad > notes.md > forbidden.ts',
      'cat $(touch forbidden.ts)',
      'cat <(touch forbidden.ts)',
      'ls =(touch forbidden.ts)',
      'ls =(touch forbidden.ts) > notes.md',
      String.raw`ls $'a\'b' =(touch forbidden.ts)`,
      "ls *(e:'touch forbidden.ts':)",
      'bash -c "touch forbidden.ts" > notes.md',
      'printf bad | sh',
      'find . -exec touch forbidden.ts \\;',
      'printf ok\ntouch forbidden.ts'
    ])('refuses Plan side effects before selecting a shell: %s', async command => {
      const selection = vi.spyOn(localShell, 'resolveLocalCommandShell').mockResolvedValue(shell)
      const root = await workspace()
      expect(await run(command, root, 'plan')).toMatchObject({ success: false, blocked: true })
      expect(selection).not.toHaveBeenCalled()
      expect(existsSync(path.join(root, 'forbidden.ts'))).toBe(false)
      expect(existsSync(path.join(root, 'notes.md'))).toBe(false)
    })

    it.each([
      "printf '%s' '=(touch forbidden.ts)'",
      'printf "%s" "=(touch forbidden.ts)"',
      String.raw`printf '%s' \=\(touch\ forbidden.ts\)`
    ])('keeps quoted or escaped zsh substitution text literal: %s', async command => {
      vi.spyOn(localShell, 'resolveLocalCommandShell').mockResolvedValue(shell)
      const root = await workspace()
      expect(await run(command, root, 'plan')).toMatchObject({ success: true, shell, stdout: '=(touch forbidden.ts)' })
      expect(existsSync(path.join(root, 'forbidden.ts'))).toBe(false)
    })

    it('reports a command failure without executing it again in another shell', async () => {
      const selection = vi.spyOn(localShell, 'resolveLocalCommandShell').mockResolvedValue(shell)
      const root = await workspace()
      const result = await run('printf x >> attempts.txt; exit 7', root)
      expect(result).toMatchObject({ success: false, exitCode: 7, shell })
      expect(selection).toHaveBeenCalledTimes(1)
      expect(await readFile(path.join(root, 'attempts.txt'), 'utf8')).toBe('x')
    })
  })
}

it('returns an actionable unavailable result with no fabricated exit code', async () => {
  vi.spyOn(localShell, 'resolveLocalCommandShell').mockRejectedValue(new Error('Install bash or zsh.'))
  const result = await run('printf ok', await workspace())
  expect(result).toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE' })
  expect(result.reason).toContain('Install bash or zsh')
  expect(result).not.toHaveProperty('exitCode')
  expect(result).not.toHaveProperty('shell')
})

it('applies managed patches without selecting a shell', async () => {
  const selection = vi.spyOn(localShell, 'resolveLocalCommandShell').mockRejectedValue(new Error('no shells'))
  const root = await workspace()
  const result = await run("apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: notes.md\n+ls =(touch forbidden.ts)\n*** End Patch\nPATCH", root, 'plan')
  expect(result.success).toBe(true)
  expect(result).not.toHaveProperty('shell')
  expect(selection).not.toHaveBeenCalled()
  expect(await readFile(path.join(root, 'notes.md'), 'utf8')).toBe('ls =(touch forbidden.ts)\n')
  expect(existsSync(path.join(root, 'forbidden.ts'))).toBe(false)
})

it('does not select or start a shell after Stop', async () => {
  const selection = vi.spyOn(localShell, 'resolveLocalCommandShell')
  const result = await run('printf no > started.txt', await workspace(), 'dangerous', { abortSignal: AbortSignal.abort() })
  expect(result).toMatchObject({ success: false, stopped: true })
  expect(result).not.toHaveProperty('shell')
  expect(selection).not.toHaveBeenCalled()
})

it('keeps managed helper agent guidance in sync', () => {
  const helper = readFileSync(path.resolve('scripts/mode4-controls-mcp.cjs'), 'utf8')
  expect(helper).toContain(NATIVE_BASH_SHELL_GUIDANCE)
})
