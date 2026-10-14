import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppActionsDocument } from './document'
import { APP_ACTIONS_VERSION } from './catalog'
import { appActionAvailability, appActionHandler, appActionObservation, appActionsHaveDrafts } from './owners'
import SettingsTopology from './SettingsTopology.fixture.svelte'

vi.mock('$lib/components/settings/panels/AgentSettingsPanel.svelte', async () => ({ default: (await import('./SettingsOwner.fixture.svelte')).default }))
vi.mock('$lib/components/settings/panels/ModelSettingsPanel.svelte', async () => ({ default: (await import('./SettingsOwner.fixture.svelte')).default }))
vi.mock('$lib/components/settings/panels/GoonsSettingsPanel.svelte', async () => ({ default: (await import('./SettingsOwner.fixture.svelte')).default }))
vi.mock('$lib/components/settings/panels/MCPSettingsPanel.svelte', async () => ({ default: (await import('./SettingsOwner.fixture.svelte')).default }))

const documents: ReturnType<typeof createAppActionsDocument>[] = []
afterEach(() => { for (const doc of documents.splice(0)) doc.retire(); vi.unstubAllGlobals() })
function setup() {
  const mounted = render(SettingsTopology)
  const doc = createAppActionsDocument({ documentId: 'topology-doc', documentEpoch: 'topology-epoch',
    session: () => null, handler: appActionHandler, observation: appActionObservation,
    availability: appActionAvailability, feedback: vi.fn() })
  documents.push(doc)
  let sequence = 0
  const execute = (actionId: string, args = {}) => doc.execute({ catalogVersion: APP_ACTIONS_VERSION,
    documentId: 'topology-doc', documentEpoch: 'topology-epoch', requestId: `topology-${++sequence}`,
    expectedSessionId: null, expiresAt: Date.now() + 4000, actionId, args })
  const openOwners = () => JSON.parse(screen.getByTestId('topology-owners').textContent!)
  return { ...mounted, doc, execute, openOwners }
}

describe('the actual sidebar + AgentSelector + ModelSelector Settings topology', () => {
  it('mounts all three panels without duplicate registration and opens only the first mounted host', async () => {
    const { execute, openOwners } = setup()
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'completed' })
    expect(openOwners()).toEqual({ sidebar: true, agent: false, model: false })
    expect(screen.getAllByText('Theme Controls In Progress')).toHaveLength(1)
    expect(appActionObservation().settings).toMatchObject({ open: true, tab: 'theme' })
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'no_op' })
    expect(await execute('settings.close')).toMatchObject({ status: 'completed' })
    expect(openOwners()).toEqual({ sidebar: false, agent: false, model: false })
  })
  it('uses the human-opened agent panel and preserves its multiline draft without opening the sidebar', async () => {
    const { execute, openOwners } = setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Human agent Settings' }))
    await screen.findByTestId('settings-owner-fixture')
    expect(appActionObservation().settings).toMatchObject({ open: true, tab: 'agents' })
    await fireEvent.click(screen.getByRole('button', { name: 'Edit multiline' }))
    const field = screen.getByRole('textbox') as HTMLTextAreaElement
    await fireEvent.input(field, { target: { value: 'secondary owner\nretained draft' } })
    await waitFor(() => expect(appActionsHaveDrafts()).toBe(true))
    expect(await execute('settings.open', { tab: 'agents' })).toMatchObject({ status: 'no_op' })
    expect(await execute('settings.close')).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    expect(openOwners()).toEqual({ sidebar: false, agent: true, model: false })
    expect(field.value).toBe('secondary owner\nretained draft')
  })
  it.each(['Save', 'Discard'] as const)('retains secondary-owner human Zip Options through Goon %s', async choice => {
    const { execute, openOwners } = setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Human agent Settings' }))
    await screen.findByTestId('settings-owner-fixture')
    expect(await execute('settings.open', { tab: '3d-goons' })).toMatchObject({ status: 'completed' })
    await fireEvent.click(screen.getByRole('button', { name: 'Make Goon draft' }))
    await waitFor(() => expect(appActionsHaveDrafts()).toBe(true))
    await fireEvent.click(screen.getByRole('button', { name: 'Human agent Zip Options' }))
    await screen.findByText('Save 3D Goons changes first?')
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'blocked', reason: 'pending_human_action' })
    expect(appActionObservation().settings).toMatchObject({ tab: '3d-goons', pendingHumanAction: true })
    await fireEvent.click(screen.getByRole('button', { name: `${choice} Changes` }))
    await waitFor(() => expect(appActionObservation().settings).toMatchObject({ tab: 'tools', toolsTab: 'zip-options', dirty: false, pendingHumanAction: false }))
    expect(openOwners()).toEqual({ sidebar: false, agent: true, model: false })
    expect(await execute('settings.close')).toMatchObject({ status: 'completed' })
    expect(openOwners()).toEqual({ sidebar: false, agent: false, model: false })
  })
  async function openRealGuardedGoon(host: 'sidebar' | 'agent' = 'sidebar', target: 'tab' | 'sheet-close' = 'tab') {
    const f = setup()
    if (host === 'agent') await fireEvent.click(screen.getByRole('button', { name: 'Human agent Settings' }))
    expect(await f.execute('settings.open', { tab: '3d-goons' })).toMatchObject({ status: 'completed' })
    const goonPanel = screen.getByRole('tabpanel', { name: '3D Goons', exact: true })
    const draftContent = within(goonPanel).getByTestId('settings-owner-fixture')
    await fireEvent.click(within(goonPanel).getByRole('button', { name: 'Make Goon draft' }))
    await waitFor(() => expect(appActionsHaveDrafts()).toBe(true))
    const goons = screen.getAllByRole('tab', { name: '3D Goons', exact: true })[0]
    const tools = screen.getAllByRole('tab', { name: 'Tools', exact: true })[0]
    const requestedControl = target === 'tab' ? tools : document.querySelectorAll<HTMLButtonElement>('#batshit-settings-form .batshit-settings-nav-close')[1]
    requestedControl.focus()
    await fireEvent.click(requestedControl)
    await screen.findByRole('dialog', { name: 'Save 3D Goons changes first?' })
    return { ...f, goons, tools, draftContent }
  }
  it.each([
    ['Stay Here', 'sidebar', 'tab'],
    ['Escape', 'sidebar', 'tab'],
    ['Close', 'agent', 'tab'],
    ['Stay Here', 'agent', 'sheet-close'],
  ] as const)('restores %s focus in the %s owner after %s without reopening the dirty-draft guard', async (dismissal, host, target) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const { execute, tools, draftContent } = await openRealGuardedGoon(host, target)
    const field = screen.getByRole('textbox', { name: 'Goon fixture draft' }) as HTMLTextAreaElement
    const draft = 'retained Goon draft\nsecond line stays exact'
    await fireEvent.input(field, { target: { value: draft } })
    const responsiveGoonsTabs = screen.getAllByRole('tab', { name: '3D Goons', exact: true })
    const goons = responsiveGoonsTabs[responsiveGoonsTabs.length - 1]
    // jsdom has no layout: only the desktop tab has a rendered rectangle.
    // Earlier responsive copies remain unrendered; actual browser breakpoints are a later gate.
    vi.spyOn(goons, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 30)] as unknown as DOMRectList)
    expect(goons.isConnected).toBe(true)
    expect(goons.getClientRects().length).toBe(1)
    expect(responsiveGoonsTabs[0].getClientRects().length).toBe(0)
    const dialog = screen.getByRole('dialog', { name: 'Save 3D Goons changes first?' })
    const button = dialog.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
    const stay = screen.getByRole('button', { name: 'Stay Here', exact: true })
    // A real click moves focus into the dialog; click alone leaves it on the refused trigger.
    const focusedControl = dismissal === 'Close' ? button : stay
    focusedControl.focus()
    expect(focusedControl).toHaveFocus()
    if (dismissal === 'Escape') await fireEvent.keyDown(document, { key: 'Escape' })
    else await fireEvent.click(focusedControl)
    await waitFor(() => expect(goons).toHaveFocus())
    expect(screen.queryByRole('dialog', { name: 'Save 3D Goons changes first?' })).toBeNull()
    expect(goons).toHaveAttribute('data-state', 'active')
    expect(tools).toHaveAttribute('data-state', 'inactive')
    expect(draftContent).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Goon fixture draft' })).toBe(field)
    expect(field.value).toBe(draft)
    expect(appActionObservation().settings).toMatchObject({ open: true, tab: '3d-goons', dirty: true, pendingHumanAction: false })
    expect(await execute('settings.open', { tab: '3d-goons' })).toMatchObject({ status: 'no_op', visible: 'unchanged', saved: 'not_requested' })
    expect(await execute('settings.close')).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    tools.focus()
    await fireEvent.click(tools)
    await screen.findByRole('dialog', { name: 'Save 3D Goons changes first?' })
    expect(screen.getAllByRole('dialog', { name: 'Save 3D Goons changes first?' })).toHaveLength(1)
    expect(field.value).toBe(draft)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps a failed Goon Save guarded and retains the exact human Tools target for Discard', async () => {
    const { execute } = setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Human agent Settings' }))
    expect(await execute('settings.open', { tab: '3d-goons' })).toMatchObject({ status: 'completed' })
    await fireEvent.click(screen.getByRole('button', { name: 'Make Goon draft' }))
    const field = screen.getByRole('textbox', { name: 'Goon fixture draft' }) as HTMLTextAreaElement
    await fireEvent.input(field, { target: { value: 'failed Save retains\nthis exact draft' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Fail Goon save' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Human agent Zip Options' }))
    const dialog = await screen.findByRole('dialog', { name: 'Save 3D Goons changes first?' })
    const save = screen.getByRole('button', { name: 'Save Changes', exact: true })
    save.focus()
    await fireEvent.click(save)
    expect(dialog).toBeVisible()
    expect(save).toHaveFocus()
    expect(field.value).toBe('failed Save retains\nthis exact draft')
    expect(appActionObservation().settings).toMatchObject({ open: true, tab: '3d-goons', dirty: true, pendingHumanAction: true })
    expect(await execute('settings.open', { tab: 'tools', toolsTab: 'cli-tools' })).toMatchObject({ status: 'blocked', reason: 'pending_human_action' })
    await fireEvent.click(screen.getByRole('button', { name: 'Discard Changes', exact: true }))
    await waitFor(() => expect(appActionObservation().settings).toMatchObject({ tab: 'tools', toolsTab: 'zip-options', dirty: false, pendingHumanAction: false }))
    expect(within(screen.getByRole('tabpanel', { name: 'Tools', exact: true })).getByTestId('settings-owner-fixture').textContent).toContain('zip-options')
  })
  it('keeps the actual Goons tab and draft visible after a real guarded tab click and Stay Here', async () => {
    const { goons, tools, draftContent } = await openRealGuardedGoon()
    expect(goons).toHaveAttribute('data-state', 'active')
    expect(tools).toHaveAttribute('data-state', 'inactive')
    await fireEvent.click(screen.getByRole('button', { name: 'Stay Here', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save 3D Goons changes first?' })).toBeNull())
    expect(goons).toHaveAttribute('data-state', 'active')
    expect(tools).toHaveAttribute('data-state', 'inactive')
    expect(draftContent).toBeVisible()
    expect(appActionObservation().settings).toMatchObject({ tab: '3d-goons', dirty: true, pendingHumanAction: false })
    tools.focus()
    await fireEvent.click(tools)
    await screen.findByRole('dialog', { name: 'Save 3D Goons changes first?' })
  })
  it('keeps a matching developer no-op truthful to the actual visible draft after human Stay Here', async () => {
    const { execute, goons, tools, draftContent } = await openRealGuardedGoon()
    await fireEvent.click(screen.getByRole('button', { name: 'Stay Here', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save 3D Goons changes first?' })).toBeNull())
    expect(await execute('settings.open', { tab: '3d-goons' })).toMatchObject({ status: 'no_op', visible: 'unchanged', saved: 'not_requested' })
    expect(goons).toHaveAttribute('data-state', 'active')
    expect(tools).toHaveAttribute('data-state', 'inactive')
    expect(draftContent).toBeVisible()
    expect(await execute('settings.close')).toMatchObject({ status: 'blocked', reason: 'unsaved_changes', visible: 'unchanged' })
    expect(draftContent).toBeVisible()
  })
  it('targets the human-opened model panel and never opens a competing hidden host', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ models: [{ id: 'existing-model' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const { execute, openOwners } = setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Human model Settings' }))
    await screen.findByTestId('settings-owner-fixture')
    expect(await execute('settings.open', { tab: 'models', modelId: 'existing-model' })).toMatchObject({ status: 'completed' })
    expect(screen.getByTestId('settings-owner-fixture').textContent).toContain('existing-model')
    expect(openOwners()).toEqual({ sidebar: false, agent: false, model: true })
    expect(await execute('settings.open', { tab: 'models', modelId: 'existing-model' })).toMatchObject({ status: 'no_op', saved: 'not_requested' })
    expect(await execute('settings.close')).toMatchObject({ status: 'completed' })
    expect(openOwners()).toEqual({ sidebar: false, agent: false, model: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(([input]) => input === '/api/user/saved-models')).toBe(true)
  })
  it('keeps a secondary-owner Stay Here cancellation distinct from a refused API request', async () => {
    const { execute, openOwners } = setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Human agent Settings' }))
    await screen.findByTestId('settings-owner-fixture')
    await execute('settings.open', { tab: '3d-goons' })
    await fireEvent.click(screen.getByRole('button', { name: 'Make Goon draft' }))
    await waitFor(() => expect(appActionsHaveDrafts()).toBe(true))
    await fireEvent.click(screen.getByRole('button', { name: 'Human agent Zip Options' }))
    await screen.findByText('Save 3D Goons changes first?')
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'blocked', reason: 'pending_human_action' })
    await fireEvent.click(screen.getByRole('button', { name: 'Stay Here' }))
    expect(appActionObservation().settings).toMatchObject({ tab: '3d-goons', dirty: true, pendingHumanAction: false })
    expect(openOwners()).toEqual({ sidebar: false, agent: true, model: false })
  })
  it('refuses two human-opened panels before entity reads or visibility effects', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const { execute, openOwners } = setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Human sidebar Settings' }))
    await screen.findByTestId('settings-owner-fixture')
    await fireEvent.click(screen.getByRole('button', { name: 'Human agent Settings' }))
    await waitFor(() => expect(openOwners()).toEqual({ sidebar: true, agent: true, model: false }))
    expect(await execute('settings.open', { tab: 'agents', agentId: 'not-read' })).toMatchObject({ status: 'blocked', reason: 'ambiguous_settings_owner', visible: 'unchanged' })
    expect(await execute('settings.close')).toMatchObject({ status: 'blocked', reason: 'ambiguous_settings_owner' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(openOwners()).toEqual({ sidebar: true, agent: true, model: false })
    expect(appActionAvailability('settings.open')).toBe('ambiguous_settings_owner')
  })
  it('keeps the dispatcher and truthful observation until the last host unmounts', async () => {
    const { execute, openOwners, rerender, unmount } = setup()
    await rerender({ sidebarMounted: false })
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'completed' })
    expect(openOwners()).toEqual({ sidebar: false, agent: true, model: false })
    await rerender({ sidebarMounted: false, agentMounted: false })
    expect(appActionObservation().settings).toMatchObject({ open: false })
    expect(await execute('settings.open', { tab: 'theme' })).toMatchObject({ status: 'completed' })
    expect(openOwners()).toEqual({ sidebar: false, agent: true, model: true })
    unmount()
    expect(appActionHandler('settings.open')).toBeUndefined()
    expect(appActionHandler('settings.close')).toBeUndefined()
    expect(appActionObservation().settings).toBeUndefined()
  })
})
