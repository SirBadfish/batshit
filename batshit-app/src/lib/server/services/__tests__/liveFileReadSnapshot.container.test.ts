// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ stat: vi.fn(), resolveRoot: vi.fn(), openReader: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat: io.stat }))
vi.mock('../bashWorkspaceRoot', () => ({ resolveBashWorkspaceRoot: io.resolveRoot }))
vi.mock('../anchoredProjectReader', () => ({
  AnchoredProjectReader: { open: io.openReader },
  AnchoredReaderCleanupError: class extends Error {}
}))

import { admitLiveFileReads } from '../liveFileReadSnapshot.server'

const input = {
  userId: 'u', agentId: 'a', sessionId: 's', executionBackend: 'local', projectPath: '/workspace/project'
}
const nativeSupported = process.platform === 'darwin' || process.platform === 'linux'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('BATSHIT_CONTAINERIZED', '0')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', 'native')
})
afterEach(() => vi.unstubAllEnvs())

describe('container refresh exclusion before workspace or reader admission', () => {
  it.each(['local', 'apple_container', 'docker_sandbox'])('refuses container %s without root resolution, stat or reader I/O', async (executionBackend) => {
    vi.stubEnv('BATSHIT_CONTAINERIZED', '1')
    expect(await admitLiveFileReads({ ...input, executionBackend }))
      .toEqual({ admitted: false, reason: 'unsupported-platform' })
    expect(io.resolveRoot).not.toHaveBeenCalled()
    expect(io.stat).not.toHaveBeenCalled()
    expect(io.openReader).not.toHaveBeenCalled()
  })

  it('also refuses the Docker runtime marker before any workspace or reader I/O', async () => {
    vi.stubEnv('BATSHIT_RUNTIME_ENV', 'docker')
    expect(await admitLiveFileReads(input)).toEqual({ admitted: false, reason: 'unsupported-platform' })
    expect(io.resolveRoot).not.toHaveBeenCalled()
    expect(io.stat).not.toHaveBeenCalled()
    expect(io.openReader).not.toHaveBeenCalled()
  })
})

describe.runIf(nativeSupported)('published native admission after the container exclusion', () => {
  it.each(['local', 'apple_container', 'docker_sandbox'])('preserves current native %s admission without opening a reader', async (executionBackend) => {
    const supported = executionBackend === 'local' || process.platform === 'darwin'
    if (supported) {
      io.resolveRoot.mockResolvedValue({ workspaceRoot: '/fixture' })
      io.stat.mockResolvedValue({ isDirectory: () => true, dev: 1n, ino: 2n })
    }
    const result = await admitLiveFileReads({ ...input, executionBackend })
    if (supported) {
      expect(result).toEqual({ admitted: true, admission: {
        userId: 'u', agentId: 'a', sessionId: 's', root: '/fixture', rootIdentity: '1:2'
      } })
      expect(io.resolveRoot).toHaveBeenCalledOnce()
      expect(io.stat).toHaveBeenCalledWith('/fixture', { bigint: true })
    } else {
      expect(result).toEqual({ admitted: false, reason: 'backend-not-local' })
      expect(io.resolveRoot).not.toHaveBeenCalled()
      expect(io.stat).not.toHaveBeenCalled()
    }
    expect(io.openReader).not.toHaveBeenCalled()
  })
})
