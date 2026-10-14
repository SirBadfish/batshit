import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import CoolToolRenderer from '../CoolToolRenderer.svelte'
import { buildHydratedCoolToolStep } from '$lib/components/chat/coolToolHydration'
import { nativeToolService } from '$lib/server/services/nativeTools'
import { resolveLocalCommandShell } from '$lib/server/services/localCommandShell'
import { adaptCoolToolsToZipSystem } from '$lib/server/coolToolZipAdapter'
import { createZipFromContent } from '$lib/server/zipService'
import { apiShellStep } from '$lib/test-utils/shell-command-steps'
import { normalizeCompactTool } from '$lib/utils/toolActivityContract'
import { normalizeToolStep } from '$lib/utils/toolResultProcessor'

vi.mock('$lib/server/services/localCommandShell', () => ({
  resolveLocalCommandShell: vi.fn()
}))

vi.mock('$lib/server/zipService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/zipService')>()
  return {
    ...actual,
    createZipFromContent: vi.fn(async (_content, type) => ({
      zipId: `${type}_shell_test`,
      reference: `{{batshit-zip:${type}_shell_test:::shell test}}`
    }))
  }
})

const workspaces: string[] = []
const command = "printf 'shell-marker'"
const installedShells = ['/bin/zsh', '/bin/bash'].filter(existsSync) as Array<'/bin/zsh' | '/bin/bash'>

async function actualShellResolver() {
  const actual = await vi.importActual<typeof import('$lib/server/services/localCommandShell')>(
    '$lib/server/services/localCommandShell'
  )
  return actual.resolveLocalCommandShell()
}

afterEach(async () => {
  vi.mocked(createZipFromContent).mockClear()
  vi.mocked(resolveLocalCommandShell).mockReset()
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })))
})

async function executedNativeStep(shell: '/bin/zsh' | '/bin/bash') {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-shell-card-'))
  workspaces.push(workspace)
  vi.mocked(resolveLocalCommandShell).mockResolvedValue(shell)

  const result = await nativeToolService.nativeBashExecute({
    command,
    workspaceRoot: workspace,
    cwd: workspace,
    accessMode: 'dangerous',
    backend: 'local'
  })
  expect(result.success).toBe(true)
  expect(result.stdout).toBe('shell-marker')
  expect(result.shell).toBe(shell)

  // apiShellStep reproduces send-routed's mapped tool step. The tool result is the actual
  // native executor result, including its exact command and selected shell.
  const step = apiShellStep({ id: `call_${path.basename(shell)}`, command, exitCode: 0 })
  step.toolResult = { ...result, input: step.toolInput, originalToolName: 'native_bash_execute' }
  return step
}

async function storedPayload(step: Record<string, any>) {
  const references = await adaptCoolToolsToZipSystem(
    [step],
    'shell-metadata-session',
    'shell-metadata-message'
  )
  expect(references).toHaveLength(1)
  const call = vi.mocked(createZipFromContent).mock.calls.find((entry) => entry[1] === 'cool_tool')
  expect(call).toBeDefined()
  return JSON.parse(call![0])
}

describe('selected shell in native command cards', () => {
  it('finds an installed system shell with the real platform resolver', async () => {
    const shell = await actualShellResolver()
    expect(shell).toMatch(/^\/(?:usr\/)?bin\/(?:zsh|bash)$/)
    expect(existsSync(shell)).toBe(true)
  })

  it.each(installedShells)(
    'preserves %s through normalization, zip storage, hydration, and the Bash card',
    async (shell) => {
      const step = await executedNativeStep(shell)
      const rawCommand = step.toolResult.command
      const normalized = normalizeToolStep(step as any)
      expect(normalized.toolResult).toMatchObject({ shell, command: rawCommand })

      const compact = normalizeCompactTool({
        toolName: step.toolName,
        originalToolName: step.originalToolName,
        toolArgs: step.toolArgs,
        toolResult: step.toolResult
      })
      expect(compact.toolResult).toMatchObject({ shell })

      const stored = await storedPayload(step)
      expect(stored.toolResult).toMatchObject({ shell, command: rawCommand })
      const hydrated = buildHydratedCoolToolStep(stored)
      expect(hydrated.toolResult).toMatchObject({ shell, command: rawCommand })
      const { container } = render(CoolToolRenderer as any, { props: { intermediateStep: hydrated, toolId: stored.toolCallId } })
      await waitFor(() => expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy())
      await fireEvent.click(container.querySelector('button[aria-expanded="false"]')!)
      await waitFor(() => expect(screen.getByText('Shell:')).toBeTruthy())
      expect(screen.getByText(shell)).toBeTruthy()
      expect(screen.getAllByText(command).length).toBeGreaterThan(0)
    }
  )

  it('keeps the selected shell when a native command maps to a Read File card', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-shell-read-'))
    workspaces.push(workspace)
    await writeFile(path.join(workspace, 'notes.md'), 'read-marker')
    const shell = await actualShellResolver()
    vi.mocked(resolveLocalCommandShell).mockResolvedValue(shell)
    const readCommand = 'cat notes.md'
    const result = await nativeToolService.nativeBashExecute({
      command: readCommand,
      workspaceRoot: workspace,
      cwd: workspace,
      accessMode: 'dangerous',
      backend: 'local'
    })
    expect(result).toMatchObject({ success: true, shell, stdout: 'read-marker' })
    const step = apiShellStep({ id: 'call_read_shell', command: readCommand, exitCode: 0 })
    step.toolResult = { ...result, input: step.toolInput, originalToolName: 'native_bash_execute' }

    const normalized = normalizeToolStep(step as any)
    expect(normalized.toolName).toBe('read_file')
    expect(normalized.toolResult).toMatchObject({ shell })
    const compact = normalizeCompactTool({
      toolName: step.toolName,
      originalToolName: step.originalToolName,
      toolArgs: step.toolArgs,
      toolResult: step.toolResult
    })
    expect(compact.toolResult).toMatchObject({ shell })
    const stored = await storedPayload(step)
    expect(stored.toolResult).toMatchObject({ shell })
    expect(buildHydratedCoolToolStep(stored).toolResult).toMatchObject({ shell })
  })

  it('does not invent shell metadata for an older command or managed apply_patch result', async () => {
    const oldStep = apiShellStep({ id: 'old_bash', command, exitCode: 0, stdout: 'shell-marker' })
    const oldNormalized = normalizeToolStep(oldStep as any)
    expect(oldNormalized.toolResult).not.toHaveProperty('shell')
    const oldStored = await storedPayload(oldStep)
    expect(oldStored.toolResult).not.toHaveProperty('shell')
    const oldHydrated = buildHydratedCoolToolStep(oldStored)
    expect(oldHydrated.toolResult).not.toHaveProperty('shell')
    const oldCard = render(CoolToolRenderer as any, {
      props: { intermediateStep: oldHydrated, toolId: oldStored.toolCallId }
    })
    await waitFor(() => expect(oldCard.container.querySelector('button[aria-expanded="false"]')).toBeTruthy())
    await fireEvent.click(oldCard.container.querySelector('button[aria-expanded="false"]')!)
    expect(screen.queryByText('Shell:')).toBeNull()
    oldCard.unmount()

    vi.mocked(createZipFromContent).mockClear()
    const patchStep = apiShellStep({
      id: 'managed_patch',
      command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch\nPATCH",
      exitCode: 0,
      stdout: 'Managed apply_patch applied 1 operation(s).'
    })
    patchStep.toolResult.managedApplyPatch = { managed: true, operationsApplied: 1, touchedPaths: ['notes.md'] }
    const patchStored = await storedPayload(patchStep)
    expect(patchStored.toolResult).not.toHaveProperty('shell')
    expect(buildHydratedCoolToolStep(patchStored).toolResult).not.toHaveProperty('shell')
  })
})
