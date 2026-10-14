import { render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CliRuntimeManagerCard from './CliRuntimeManagerCard.svelte'

/** BL-268: Agent Settings says when the Codex Batshit found is older than the one it installs. */
function summary(resolution: Record<string, unknown>) {
  return {
    runtimes: {
      codex: {
        managed: {
          installed: false,
          version: null,
          pinnedVersion: '0.155.1',
          executablePath: null,
          supported: true,
          unsupportedReason: null,
          displayName: 'Codex CLI',
          operation: null
        },
        resolution: { executable: '/zccli/codex', source: 'path', found: true, ...resolution }
      }
    },
    canManage: true
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('BL-268: the CLI runtime card', () => {
  it('warns that an older Codex may refuse newer models, next to the install button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(summary({ version: 'codex-cli 0.139.0', olderThanPinned: true }))))
    )
    const { findByTestId, getByText } = render(CliRuntimeManagerCard, { props: { runtime: 'codex' } })
    const warning = await findByTestId('cli-runtime-older-than-pinned')
    expect(warning.textContent).toContain('codex-cli 0.139.0')
    expect(warning.textContent).toContain('0.155.1')
    expect(warning.textContent).toContain('may refuse newer models')
    expect(getByText('Install Batshit-managed copy')).toBeTruthy()
  })

  it('says nothing for a current Codex', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(summary({ version: 'codex-cli 0.158.0', olderThanPinned: false }))))
    )
    const { queryByTestId, findByText } = render(CliRuntimeManagerCard, { props: { runtime: 'codex' } })
    await findByText('Using your own install found on this computer')
    await waitFor(() => expect(queryByTestId('cli-runtime-older-than-pinned')).toBeNull())
  })
})
