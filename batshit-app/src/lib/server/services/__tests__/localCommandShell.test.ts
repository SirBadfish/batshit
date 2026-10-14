import { beforeEach, describe, expect, it, vi } from 'vitest'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { resolveLocalCommandShell } from '../localCommandShell'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const access = vi.fn()
  const stat = vi.fn()
  return { ...actual, access, stat, default: { ...((actual as any).default ?? actual), access, stat } }
})

const accessMock = vi.mocked(access)
const statMock = vi.mocked(stat)

function availableShell(path: string, options: { executable?: boolean; file?: boolean } = {}) {
  statMock.mockImplementationOnce(async (candidate) => {
    expect(candidate).toBe(path)
    return { isFile: () => options.file !== false } as Awaited<ReturnType<typeof stat>>
  })
  if (options.file !== false) {
    accessMock.mockImplementationOnce(async (candidate, mode) => {
      expect(candidate).toBe(path)
      expect(mode).toBe(constants.X_OK)
      if (options.executable === false) throw new Error('EACCES')
    })
  }
}

function missingShell(path: string) {
  statMock.mockImplementationOnce(async (candidate) => {
    expect(candidate).toBe(path)
    throw new Error('ENOENT')
  })
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('local command shell selection', () => {
  it('prefers executable zsh at the first trusted path', async () => {
    availableShell('/bin/zsh')
    expect(await resolveLocalCommandShell()).toBe('/bin/zsh')
    expect(statMock).toHaveBeenCalledTimes(1)
  })

  it('uses the next zsh path before bash when the first path is absent', async () => {
    missingShell('/bin/zsh')
    availableShell('/usr/bin/zsh')
    expect(await resolveLocalCommandShell()).toBe('/usr/bin/zsh')
  })

  it('chooses executable bash after missing, non-executable, or directory zsh paths', async () => {
    availableShell('/bin/zsh', { executable: false })
    availableShell('/usr/bin/zsh', { file: false })
    availableShell('/bin/bash')
    expect(await resolveLocalCommandShell()).toBe('/bin/bash')
    expect(accessMock).toHaveBeenCalledTimes(2)
  })

  it('uses the second bash path when the first is unavailable', async () => {
    missingShell('/bin/zsh')
    missingShell('/usr/bin/zsh')
    missingShell('/bin/bash')
    availableShell('/usr/bin/bash')
    expect(await resolveLocalCommandShell()).toBe('/usr/bin/bash')
  })

  it('fails visibly when no trusted executable shell exists', async () => {
    missingShell('/bin/zsh')
    missingShell('/usr/bin/zsh')
    availableShell('/bin/bash', { executable: false })
    availableShell('/usr/bin/bash', { file: false })
    await expect(resolveLocalCommandShell()).rejects.toThrow(
      'Local shell execution needs an executable zsh or bash'
    )
  })
})
