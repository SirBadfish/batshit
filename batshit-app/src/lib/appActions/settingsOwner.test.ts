import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppActionsDocument } from './document'
import { appActionHandler, appActionObservation, appActionsHaveDrafts } from './owners'
import { APP_ACTIONS_VERSION } from './catalog'
import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte'

// Only heavyweight panel content is replaced. The production sheet, lazy mount, draft
// scope, initial-target guard and App Actions owners execute unchanged.
vi.mock('$lib/components/settings/panels/AgentSettingsPanel.svelte', async () => ({ default: (await import('./SettingsOwner.fixture.svelte')).default }))
vi.mock('$lib/components/settings/panels/GoonsSettingsPanel.svelte', async () => ({ default: (await import('./SettingsOwner.fixture.svelte')).default }))
vi.mock('$lib/components/settings/panels/MCPSettingsPanel.svelte', async () => ({ default: (await import('./SettingsOwner.fixture.svelte')).default }))

const documents: ReturnType<typeof createAppActionsDocument>[] = []
afterEach(() => { for (const doc of documents.splice(0)) doc.retire(); vi.unstubAllGlobals() })
function setup(props: Record<string, unknown> = {}) {
  const mounted = render(SettingsPanel, { props: { open: false, data: { user: { id: 'fixture-user' } }, ...props } })
  const doc = createAppActionsDocument({ documentId: 'settings-doc', documentEpoch: 'settings-epoch',
    session: () => null, handler: appActionHandler, observation: appActionObservation, feedback: vi.fn() })
  documents.push(doc)
  let sequence = 0
  const execute = (actionId: string, args = {}) => doc.execute({ catalogVersion: APP_ACTIONS_VERSION,
    documentId: 'settings-doc', documentEpoch: 'settings-epoch', requestId: `request-${++sequence}`,
    expectedSessionId: null, expiresAt: Date.now() + 4000, actionId, args })
  return { ...mounted, doc, execute }
}
describe('Settings App Actions use the real navigation and draft owner', () => {
  it('refuses the hidden Dev tab before visibility or reads', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const { execute } = setup()
    expect(await execute('settings.open', { tab: 'dev' })).toMatchObject({ status: 'blocked', reason: 'target_unavailable', visible: 'unchanged' })
    expect((appActionObservation().settings as { open: boolean }).open).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('waits for mounted settings, repeats without effects, and closes the actual sheet', async () => {
    const { execute } = setup()
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'completed', visible: 'applied' })
    expect(screen.getByText('Theme Controls In Progress')).toBeVisible()
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'no_op', saved: 'not_requested' })
    expect(await execute('settings.close')).toMatchObject({ status: 'completed' })
    expect(screen.queryByText('Theme Controls In Progress')).toBeNull()
    expect(await execute('settings.close')).toMatchObject({ status: 'no_op' })
  })
  it('validates an existing entity before any visibility effect and never accepts a launcher sentinel', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', fetcher)
    const { execute } = setup({ initialAgentId: '__create__' })
    expect(await execute('settings.open', { tab: 'agents', agentId: 'missing-agent' })).toMatchObject({ status: 'blocked', reason: 'missing_entity', visible: 'unchanged' })
    expect((appActionObservation().settings as { open: boolean }).open).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await execute('settings.open', { tab: 'agents', agentId: '__create__' })).toMatchObject({ status: 'blocked' })
    expect(await execute('settings.open', { tab: 'agents' })).toMatchObject({ status: 'completed' })
    expect(screen.getByTestId('settings-owner-fixture').textContent).toContain('launcher none')
  })
  it('preserves a multiline draft; a matching tab is a no-op and close/tab transitions refuse', async () => {
    const { execute } = setup()
    await execute('settings.open', { tab: 'agents' })
    await fireEvent.click(screen.getByRole('button', { name: 'Edit multiline' }))
    const field = screen.getByRole('textbox') as HTMLTextAreaElement
    await fireEvent.input(field, { target: { value: 'my\nretained draft' } })
    await waitFor(() => expect(appActionsHaveDrafts()).toBe(true))
    expect(await execute('settings.open', { tab: 'agents' })).toMatchObject({ status: 'no_op' })
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    expect(await execute('settings.close')).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    expect(field.value).toBe('my\nretained draft')
    expect(screen.queryByText('Save 3D Goons changes first?')).toBeNull()
  })
  it('refuses dirty Goons and leaves an existing human Save/Discard continuation owned by Settings', async () => {
    const { execute, rerender } = setup()
    await execute('settings.open', { tab: '3d-goons' })
    await fireEvent.click(screen.getByRole('button', { name: 'Make Goon draft' }))
    await waitFor(() => expect(appActionsHaveDrafts()).toBe(true))
    expect(await execute('settings.close')).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    // The real sidebar binds open. A raw rerender otherwise reapplies this test's
    // original open:false prop and closes the sheet while changing the launcher.
    await rerender({ open: true, initialTab: 'theme' })
    await screen.findByText('Save 3D Goons changes first?')
    expect(await execute('settings.open', { tab: 'tools' })).toMatchObject({ status: 'blocked', reason: 'pending_human_action' })
    await fireEvent.click(screen.getByRole('button', { name: 'Stay Here' }))
    expect((appActionObservation().settings as { tab: string }).tab).toBe('3d-goons')
  })
  it('observes the exact tools subtab after mounting rather than only the outer tools tab', async () => {
    const { execute } = setup()
    expect(await execute('settings.open', { tab: 'tools', toolsTab: 'zip-options' })).toMatchObject({ status: 'completed' })
    expect((appActionObservation().settings as { toolsTab: string }).toolsTab).toBe('zip-options')
    expect(await execute('settings.open', { tab: 'tools', toolsTab: 'zip-options' })).toMatchObject({ status: 'no_op' })
  })
  it.each(['Save', 'Discard'] as const)('retains a human Zip Options launcher through Goon %s', async choice => {
    const { execute, rerender } = setup()
    await execute('settings.open', { tab: '3d-goons' })
    await fireEvent.click(screen.getByRole('button', { name: 'Make Goon draft' }))
    await waitFor(() => expect(appActionsHaveDrafts()).toBe(true))
    await rerender({ open: true, initialTab: 'tools', initialToolsTab: 'zip-options' })
    await screen.findByText('Save 3D Goons changes first?')
    expect((appActionObservation().settings as { tab: string }).tab).toBe('3d-goons')
    await fireEvent.click(screen.getByRole('button', { name: `${choice} Changes` }))
    await waitFor(() => expect(appActionObservation().settings).toMatchObject({
      tab: 'tools', toolsTab: 'zip-options', dirty: false, pendingHumanAction: false
    }))
    expect(screen.getByTestId('settings-owner-fixture').textContent).toContain('zip-options')
  })
  it('Stay Here cancels the human Tools target and never revives a refused developer request', async () => {
    const { execute, rerender, doc } = setup()
    await execute('settings.open', { tab: '3d-goons' })
    await fireEvent.click(screen.getByRole('button', { name: 'Make Goon draft' }))
    await waitFor(() => expect(appActionsHaveDrafts()).toBe(true))
    // This API request refuses before a continuation exists. It must stay refused
    // after the unrelated human action is canceled and the draft later becomes clean.
    const input = { ...doc.state(), requestId: 'refused-tools', expiresAt: Date.now() + 4000,
      actionId: 'settings.open', args: { tab: 'tools', toolsTab: 'cli-tools' } }
    const { mounted: _mounted, busy: _busy, view: _view, receiptCapacityRemaining: _remaining, ...request } = input
    const refusal = doc.execute(request)
    expect(await refusal).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    await rerender({ open: true, initialTab: 'tools', initialToolsTab: 'zip-options' })
    await screen.findByText('Save 3D Goons changes first?')
    await fireEvent.click(screen.getByRole('button', { name: 'Stay Here' }))
    expect(appActionObservation().settings).toMatchObject({ tab: '3d-goons', dirty: true, pendingHumanAction: false })
    expect(doc.execute(request)).toBe(refusal)
    // Start a fresh explicit human launcher, then discard. The prior API receipt
    // cannot substitute its CLI target for the user's new Zip Options target.
    await rerender({ open: true, initialTab: 'theme' })
    await screen.findByText('Save 3D Goons changes first?')
    await fireEvent.click(screen.getByRole('button', { name: 'Stay Here' }))
    await rerender({ open: true, initialTab: 'tools', initialToolsTab: 'zip-options' })
    await screen.findByText('Save 3D Goons changes first?')
    await fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }))
    await waitFor(() => expect(appActionObservation().settings).toMatchObject({ tab: 'tools', toolsTab: 'zip-options', dirty: false }))
    expect(doc.execute(request)).toBe(refusal)
    expect(await refusal).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
  })
})
