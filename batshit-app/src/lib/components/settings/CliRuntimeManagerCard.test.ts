import { render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CliRuntimeManagerCard from './CliRuntimeManagerCard.svelte'

/** BL-268: Agent Settings says when the Claude Code Batshit found is older than the one it installs. */
function summary(resolution: Record<string, unknown>) {
  return {
    runtimes: {
      claude: {
        managed: {
          installed: false,
          version: null,
          pinnedVersion: '2.1.296',
          executablePath: null,
          supported: true,
          unsupportedReason: null,
          displayName: 'Claude Code CLI',
          operation: null
        },
        resolution: { executable: '/zccli/claude', source: 'path', found: true, ...resolution }
      }
    },
    canManage: true
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('BL-268: the CLI runtime card', () => {
  it('warns that an older Claude Code may refuse newer models, next to the install button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(summary({ version: '2.1.283 (Claude Code)', olderThanPinned: true }))))
    )
    const { findByTestId, getByText } = render(CliRuntimeManagerCard, { props: { runtime: 'claude' } })
    const warning = await findByTestId('cli-runtime-older-than-pinned')
    expect(warning.textContent).toContain('This Claude Code CLI is version 2.1.283 (Claude Code)')
    expect(warning.textContent).toContain('2.1.296')
    expect(warning.textContent).toContain('may refuse newer models')
    expect(getByText('Install Batshit-managed copy')).toBeTruthy()
  })

  it('says nothing for a current Claude Code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(summary({ version: '2.1.296 (Claude Code)', olderThanPinned: false }))))
    )
    const { queryByTestId, findByText } = render(CliRuntimeManagerCard, { props: { runtime: 'claude' } })
    await findByText('Using your own install found on this computer')
    await waitFor(() => expect(queryByTestId('cli-runtime-older-than-pinned')).toBeNull())
  })
})
