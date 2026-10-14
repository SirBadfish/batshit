import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import UserSettingsPanel from './UserSettingsPanel.svelte'

/**
 * BL-481: after saving the Global System Prompt, Settings > User autosaved nothing more for
 * the rest of the visit. `saveGlobalPrompt` set the plain flag `suppressNextAutoSave`; the
 * autosave `$effect` returned on that flag BEFORE reading any `settings` field, so from then
 * on it tracked only `isLoading` and never re-ran for a later edit. Fix: delete the flag —
 * `saveGlobalPrompt` already saves the full payload, but that alone let a second bug through:
 * `persistedSettings` is not updated until the explicit save's POST resolves, so the shared
 * autosave effect (re-run because `saveGlobalPrompt` mutated `settings`) sees `hasChanges` while
 * that POST is still in flight and queues an identical copy about 500ms later — a duplicate
 * send if the first POST succeeded, and a silent, un-requested retry if it failed (bending the
 * Settings Auto-Save Contract's "retry only on a deliberate next edit"). Fix:
 * `lastDispatchedSignature` records the payload the moment ANY send starts, and is cleared again
 * once it fails (so a later DELIBERATE retry of the same value is never blocked); the effect
 * skips queuing a save whose payload signature currently matches it.
 *
 * Renders the REAL panel end to end: opens the real Global System Prompt editor, saves it, and
 * counts POSTs precisely (exactly one for the prompt, no duplicate), then edits the display
 * name and proves exactly one more real autosave fires (no duplicate there either).
 */

type Saved = { body: any }

function stubFetch(initial: Record<string, unknown>) {
  const saves: Saved[] = []
  let current: Record<string, unknown> = { ...initial }
  let failNextPost = false
  let holdNextPost = false
  const held: Array<() => void> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === '/api/user/settings' && method === 'GET') {
        return new Response(JSON.stringify({ settings: current }), { status: 200 })
      }
      if (url === '/api/user/settings' && method === 'POST') {
        if (failNextPost) {
          failNextPost = false
          return new Response(JSON.stringify({ error: 'Simulated save failure' }), { status: 500 })
        }
        if (holdNextPost) {
          holdNextPost = false
          await new Promise<void>((resolve) => held.push(resolve))
        }
        const body = JSON.parse(String(init?.body ?? '{}'))
        saves.push({ body })
        current = { ...current, ...body }
        return new Response(JSON.stringify({ settings: current }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: `unrouted ${method} ${url}` }), { status: 501 })
    })
  )
  return {
    saves,
    failNextPostOnce: () => {
      failNextPost = true
    },
    holdNextPostOnce: () => {
      holdNextPost = true
    },
    releaseHeldPost: () => {
      const resolve = held.shift()
      if (resolve) resolve()
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Settings > User autosave after a Global System Prompt save (BL-481)', () => {
  it('still autosaves a later display-name edit', async () => {
    const { saves } = stubFetch({
      displayName: 'Josh',
      avatar_url: null,
      avatar_icon_ref: null,
      avatar_icon_fit: 'fill',
      global_custom_system_prompt: '',
      global_chat_settings: { busy_send_mode: 'steer' }
    })

    render(UserSettingsPanel, {
      props: {
        data: {
          user: { id: 'u1', email: 'fixture@example.invalid' },
          userSettings: null
        }
      }
    })

    const nameInput = (await screen.findByLabelText('Display Name')) as HTMLInputElement
    expect(nameInput.value).toBe('Josh')

    // Save the Global System Prompt through the real editor sheet.
    await fireEvent.click(screen.getByRole('button', { name: /Create Global System Prompt/ }))
    const textarea = await screen.findByPlaceholderText('Enter system prompt...')
    await fireEvent.input(textarea, { target: { value: 'Be nice.' } })
    await fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(1))
    // Settle past the 500ms autosave debounce window before counting: a duplicate copy queued
    // by the shared effect would land in here, not at the first POST.
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(saves).toHaveLength(1)
    expect(saves[0].body.global_custom_system_prompt).toBe('Be nice.')

    // A later, real edit must still autosave exactly once more — this is what the old flag
    // silently broke, and the duplicate-send fix must not send this one twice either.
    await fireEvent.input(nameInput, { target: { value: 'Joshua' } })

    await waitFor(() => expect(saves).toHaveLength(2), { timeout: 3000 })
    expect(saves[1].body.displayName).toBe('Joshua')

    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(saves).toHaveLength(2)
  })
})

describe('Settings > User: a failed save never auto-retries, but a later edit still saves (BL-481 review item 3)', () => {
  it('shows the error, sends nothing more on its own, then saves a later deliberate edit', async () => {
    const { saves, failNextPostOnce } = stubFetch({
      displayName: 'Josh',
      avatar_url: null,
      avatar_icon_ref: null,
      avatar_icon_fit: 'fill',
      global_custom_system_prompt: '',
      global_chat_settings: { busy_send_mode: 'steer' }
    })

    render(UserSettingsPanel, {
      props: { data: { user: { id: 'u1', email: 'fixture@example.invalid' }, userSettings: null } }
    })

    await screen.findByLabelText('Display Name')
    await fireEvent.click(screen.getByRole('button', { name: /Create Global System Prompt/ }))
    const textarea = await screen.findByPlaceholderText('Enter system prompt...')
    await fireEvent.input(textarea, { target: { value: 'Be nice.' } })

    failNextPostOnce()
    await fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    // The failure surfaces...
    await waitFor(() => expect(screen.getByText('Simulated save failure')).toBeTruthy())
    expect(saves).toHaveLength(0)

    // ...and nothing retries it on its own, even past the debounce window (this is what would
    // reopen if `lastDispatchedSignature` were never cleared on failure AND the effect kept
    // re-running for an unrelated reason — asserted here directly).
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(saves).toHaveLength(0)

    // A later, deliberate edit — of the SAME field, to the SAME value that just failed — must
    // still save. This is exactly what `lastDispatchedSignature` would wrongly keep blocking
    // forever if it were not cleared on failure.
    const nameInput = screen.getByLabelText('Display Name') as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: 'Different' } })
    await fireEvent.input(nameInput, { target: { value: 'Josh' } })

    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 })
    expect(saves[0].body.global_custom_system_prompt).toBe('Be nice.')
    expect(saves[0].body.displayName).toBe('Josh')
  })
})

describe('Settings > User: an edit made and reverted while a save is in flight (BL-481 review item 1/2)', () => {
  it('never sends the abandoned value, and the server ends up matching the field', async () => {
    const { saves, holdNextPostOnce, releaseHeldPost } = stubFetch({
      displayName: 'Josh',
      avatar_url: null,
      avatar_icon_ref: null,
      avatar_icon_fit: 'fill',
      global_custom_system_prompt: '',
      global_chat_settings: { busy_send_mode: 'steer' }
    })

    render(UserSettingsPanel, {
      props: { data: { user: { id: 'u1', email: 'fixture@example.invalid' }, userSettings: null } }
    })

    const nameInput = (await screen.findByLabelText('Display Name')) as HTMLInputElement

    // Edit to X ("First") and let the debounce fire — hold its POST open so it stays in flight.
    holdNextPostOnce()
    await fireEvent.input(nameInput, { target: { value: 'First' } })
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(saves).toHaveLength(0) // still held, not yet counted as a completed save

    // While that save is in flight, edit to Y ("Second")...
    await fireEvent.input(nameInput, { target: { value: 'Second' } })
    // ...then, within the 500ms debounce window, edit back to X ("First") before Y ever sends.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await fireEvent.input(nameInput, { target: { value: 'First' } })

    // Let every timer that could possibly fire actually run, then release the held POST for X.
    await new Promise((resolve) => setTimeout(resolve, 900))
    releaseHeldPost()

    await waitFor(() => expect(saves).toHaveLength(1))
    // Give any wrongly-surviving queued send of "Second" every remaining chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 900))

    expect(saves).toHaveLength(1)
    expect(saves[0].body.displayName).toBe('First')
    expect(nameInput.value).toBe('First')
  })
})

describe('Settings > User: a cancelled queued save settles back to idle (BL-481 re-review)', () => {
  it('typing then reverting within the debounce window clears the "Saving..." chip and posts nothing', async () => {
    const { saves } = stubFetch({
      displayName: 'Josh',
      avatar_url: null,
      avatar_icon_ref: null,
      avatar_icon_fit: 'fill',
      global_custom_system_prompt: '',
      global_chat_settings: { busy_send_mode: 'steer' }
    })

    render(UserSettingsPanel, {
      props: { data: { user: { id: 'u1', email: 'fixture@example.invalid' }, userSettings: null } }
    })

    const nameInput = (await screen.findByLabelText('Display Name')) as HTMLInputElement

    // Type a character — queues a save and shows "Saving...".
    await fireEvent.input(nameInput, { target: { value: 'Joshx' } })
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeTruthy())

    // Backspace it, well within the 500ms debounce window: the field is back to the persisted
    // value, so the queued save for "Joshx" must be cancelled AND the chip must settle back to
    // idle — not stay stuck on "Saving..." forever (nothing else would ever clear it, since the
    // cancelled save never resolves).
    await fireEvent.input(nameInput, { target: { value: 'Josh' } })
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeNull())

    // Give the (cancelled) save every chance it would have had to fire anyway.
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(saves).toHaveLength(0)
  })
})

describe('Settings > User: an invalid edit cancels the queued save for the value before it (BL-481 re-review)', () => {
  it('sends nothing for a value the field no longer shows once it becomes invalid', async () => {
    const { saves } = stubFetch({
      displayName: 'Josh',
      avatar_url: null,
      avatar_icon_ref: null,
      avatar_icon_fit: 'fill',
      global_custom_system_prompt: '',
      global_chat_settings: { busy_send_mode: 'steer' }
    })

    render(UserSettingsPanel, {
      props: { data: { user: { id: 'u1', email: 'fixture@example.invalid' }, userSettings: null } }
    })

    const nameInput = (await screen.findByLabelText('Display Name')) as HTMLInputElement

    // A valid edit queues a save for "Jo"...
    await fireEvent.input(nameInput, { target: { value: 'Jo' } })
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeTruthy())

    // ...then, within the debounce window, the field becomes invalid (empty) — "Jo" must never
    // post: the field no longer shows it, and a successful stray send would say "Saved" for a
    // value that was never actually the field's content at that point.
    await fireEvent.input(nameInput, { target: { value: '' } })

    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(saves).toHaveLength(0)
  })
})
