import { render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import ExecutionViewerSheet from '$lib/components/chat/ExecutionViewerSheet.svelte'
import { createAppActionsDocument } from './document'
import { APP_ACTIONS_VERSION } from './catalog'
import { appActionHandler, appActionObservation, registerAppActionDraft, retireAppActionNavigation } from './owners'

const cleanup: (() => void)[] = []
afterEach(() => { for (const remove of cleanup.splice(0)) remove(); vi.unstubAllGlobals() })
function fixture(sessionId: string | null = 'session-one') {
  let selected = sessionId
  const rendered = render(ExecutionViewerSheet, { props: { open: false, sessionId } })
  const doc = createAppActionsDocument({ documentId: 'execution-doc', documentEpoch: 'execution-epoch',
    session: () => selected, handler: appActionHandler, observation: appActionObservation, feedback: vi.fn() })
  cleanup.push(doc.retire)
  let sequence = 0
  const request = () => ({ catalogVersion: APP_ACTIONS_VERSION, documentId: 'execution-doc',
    documentEpoch: 'execution-epoch', expectedSessionId: selected, requestId: `open-${++sequence}`,
    actionId: 'execution.open', args: {}, expiresAt: Date.now() + 4000 })
  return { ...rendered, doc, request, select: async (id: string) => {
    selected = id; retireAppActionNavigation(); await rendered.rerender({ open: true, sessionId: id }); await tick()
  } }
}
function installFetch(log: (url: string) => Promise<Response>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    return url.endsWith('/execution-log') ? log(url) : Response.json({ approvals: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
describe('Execution App Action observes the actual selected-session sheet', () => {
  it('reports an empty selected session and repeats without another fetch', async () => {
    const fetcher = installFetch(async () => Response.json({ entries: [] }))
    const { doc, request } = fixture()
    const input = request()
    const result = await doc.execute(input)
    expect(result).toMatchObject({ status: 'completed', sessionId: 'session-one', viewer: 'empty' })
    expect(await doc.execute(input)).toEqual(result)
    expect(await doc.execute(request())).toMatchObject({ status: 'no_op', viewer: 'empty' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/execution-log'))).toHaveLength(1)
  })
  it('reports no selected session without fetching an invented session', async () => {
    const fetcher = installFetch(async () => { throw new Error('must not fetch') })
    const { doc, request } = fixture(null)
    expect(await doc.execute(request())).toMatchObject({ status: 'completed', sessionId: null, viewer: 'no_session' })
    expect(screen.getByText('No session is selected.')).toBeVisible()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('reports load failure separately from empty history', async () => {
    installFetch(async () => Response.json({ error: 'fixture unavailable' }, { status: 503 }))
    const { doc, request } = fixture()
    expect(await doc.execute(request())).toMatchObject({ status: 'failed', reason: 'viewer_load_failed' })
    expect(screen.queryByText('No execution records yet.')).toBeNull()
  })
  it('retains a draft and refuses before opening or reading history', async () => {
    const fetcher = installFetch(async () => Response.json({ entries: [] }))
    const { doc, request } = fixture()
    cleanup.push(registerAppActionDraft(() => true))
    expect(await doc.execute(request())).toMatchObject({ status: 'blocked', reason: 'unsaved_changes' })
    expect((appActionObservation().execution as { open: boolean }).open).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not apply a late old-session load after a selection interrupts the action', async () => {
    let release!: (response: Response) => void
    installFetch(url => url.includes('session-one') ? new Promise(resolve => { release = resolve }) : Promise.resolve(Response.json({ entries: [] })))
    const { doc, request, select } = fixture()
    const flight = doc.execute(request())
    await waitFor(() => expect(release).toBeTypeOf('function'))
    await select('session-two')
    expect(await flight).toMatchObject({ status: 'unknown_outcome', reason: 'user_navigation' })
    release(Response.json({ entries: [{ id: 'old', sessionId: 'session-one', agentName: 'Old response must not render' }] }))
    await waitFor(() => expect((appActionObservation().execution as { loadedSessionId: string }).loadedSessionId).toBe('session-two'))
    expect(screen.queryByText('Old response must not render')).toBeNull()
    expect(await doc.execute(request())).toMatchObject({ status: 'no_op', sessionId: 'session-two', viewer: 'empty' })
  })
})
