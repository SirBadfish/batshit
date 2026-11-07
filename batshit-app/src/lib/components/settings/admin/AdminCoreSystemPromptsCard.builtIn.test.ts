import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import AdminCoreSystemPromptsCard from './AdminCoreSystemPromptsCard.svelte'
import type { CoreSystemPromptSummary } from './adminSettingsTypes'

/**
 * Josh (2026-10-23): a stored prompt with built-in text offers Built-in Text beside Edit and Reset;
 * a built-in-only section is marked Built In and offers only View.
 */
const base: CoreSystemPromptSummary = {
  id: 'x', redisKey: 'batshit:x', label: 'X', description: 'd', warning: '', defaultFile: 'x.md',
  defaultVersion: '1', matchesDefault: true, customized: false, newDefaultAvailable: false, lastUpdated: null
}
const prompts: CoreSystemPromptSummary[] = [
  { ...base, id: 'api_primary', label: 'Primary Agent System Prompt', hasBuiltInText: false },
  { ...base, id: 'tool_guidance_zip', label: 'Tool Prompt: Zips', hasBuiltInText: true },
  { ...base, id: 'working_context', label: 'Maintaining Your Working Context', redisKey: '', defaultFile: '', readOnly: true, hasBuiltInText: true }
]

function renderCard(rows = prompts) {
  const handlers = { onRetry: vi.fn(), onEdit: vi.fn(), onReset: vi.fn(), onViewBuiltIn: vi.fn() }
  render(AdminCoreSystemPromptsCard, { props: { prompts: rows, loading: false, error: null, busyId: null, viewBusyId: null, ...handlers } })
  const row = (label: string) => screen.getByText(label).closest('.batshit-settings-muted-panel') as HTMLElement
  return { handlers, row }
}

describe('AdminCoreSystemPromptsCard: built-in text', () => {
  it('keeps the repair editor available when a custom prompt has invalid runtime markers', async () => {
    const notice = 'This custom prompt has invalid runtime markers. Review and repair its markers before use. Your saved text is unchanged.'
    const { handlers, row } = renderCard([{ ...base, id: 'api_primary', label: 'Broken custom prompt', customized: true,
      matchesDefault: false, setupCompatibilityNotice: notice }])
    const broken = within(row('Broken custom prompt'))
    expect(broken.getByText(notice)).toBeTruthy()
    await fireEvent.click(broken.getByRole('button', { name: /Edit/ }))
    expect(handlers.onEdit).toHaveBeenCalledWith('api_primary')
    expect(handlers.onReset).not.toHaveBeenCalled()
  })
  it('shows a stale custom setup notice without editing or resetting saved text', () => {
    const { handlers, row } = renderCard([{ ...base, id: 'api_primary', label: 'Custom Primary',
      customized: true, matchesDefault: false, setupCompatibilityNotice: 'Review Agent Setup and setup_changes.' }])
    expect(within(row('Custom Primary')).getByText('Review Agent Setup and setup_changes.')).toBeTruthy()
    expect(handlers.onEdit).not.toHaveBeenCalled()
    expect(handlers.onReset).not.toHaveBeenCalled()
  })
  it('a stored prompt with built-in text offers Built-in Text, Edit and Reset; one without has no Built-in Text', async () => {
    const { handlers, row } = renderCard()
    const zip = within(row('Tool Prompt: Zips'))
    expect(zip.getByRole('button', { name: /Edit/ })).toBeTruthy()
    expect(zip.getByRole('button', { name: /Reset/ })).toBeTruthy()
    await fireEvent.click(zip.getByRole('button', { name: /Built-in Text/ }))
    expect(handlers.onViewBuiltIn).toHaveBeenCalledWith('tool_guidance_zip')
    expect(within(row('Primary Agent System Prompt')).queryByRole('button', { name: /Built-in Text/ })).toBeNull()
  })

  it('a built-in-only section is marked Built In, says it is read-only, and offers only View', async () => {
    const { handlers, row } = renderCard()
    const section = within(row('Maintaining Your Working Context'))
    expect(section.getByText('Built in')).toBeTruthy()
    expect(section.getByText('Built into Batshit (read-only)')).toBeTruthy()
    expect(section.queryByRole('button', { name: /Edit/ })).toBeNull()
    expect(section.queryByRole('button', { name: /Reset/ })).toBeNull()
    expect(section.queryByText('Batshit default')).toBeNull()
    await fireEvent.click(section.getByRole('button', { name: /View/ }))
    expect(handlers.onViewBuiltIn).toHaveBeenCalledWith('working_context')
  })
})
