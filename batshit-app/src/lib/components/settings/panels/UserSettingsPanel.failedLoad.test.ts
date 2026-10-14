import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  installUserSettingsRoutes,
  loadUserSettingsRoute,
  storedUserSettings
} from '$lib/test-utils/userSettingsRoute'
import UserSettingsPanel from './UserSettingsPanel.svelte'

/**
 * BL-962 (the class of BL-939 and BL-487): when `GET /api/user/settings` failed, the User panel
 * showed the page's copy of the settings (or the defaults) in editable fields and ended its
 * load. The next edit posted the whole record the panel owns (name, avatar, Global System
 * Prompt, busy-send mode), built from that copy, and the route stores each of those it is sent,
 * so a saved Global System Prompt, avatar and busy-send mode the copy did not hold were erased.
 * Now only a successful read counts as a loaded copy: until then the three cards that hold saved
 * values (Profile, Global System Prompt, Chat) are not offered at all, the panel says so in a
 * plain sentence with a Retry, and a Retry that works shows the saved values and saves as before.
 * Every writer holds the rule: the autosave (name, avatar, icon, busy-send mode) and the Global
 * System Prompt editor's own save.
 *
 * Renders the REAL panel. `/api/user/settings` goes to the REAL route handlers on the default
 * lane's Redis fake, so every assertion below reads what is STORED, not what the panel sent.
 */

useRedisTestServer()

const USER = 'user962_user'
const SAVE_DEBOUNCE_PAST = 1500

/** Saved values: every one differs from its default, so an erasure is visible. */
const SAVED = {
  displayName: 'Josh',
  avatar_url: '/uploads/avatars/user962_user-saved.png',
  avatar_icon_ref: { kind: 'lucide', id: 'brain' },
  avatar_icon_fit: 'fill',
  global_custom_system_prompt: 'Be kind to Josh.',
  global_chat_settings: { busy_send_mode: 'queue' }
} as const

/** The page's copy from when the page opened: a real copy, but not what is saved now. */
const PAGE_COPY = {
  displayName: 'Old',
  avatar_url: '/uploads/avatars/user962_user-old.png',
  avatar_icon_ref: { kind: 'lucide', id: 'search' },
  avatar_icon_fit: 'fill',
  global_custom_system_prompt: 'An older prompt.',
  global_chat_settings: { busy_send_mode: 'steer' }
}

/** The six keys the panel sends for one edit. */
const SENT_KEYS = [
  'displayName',
  'avatar_url',
  'avatar_icon_ref',
  'avatar_icon_fit',
  'global_custom_system_prompt',
  'global_chat_settings'
]

function ensureBrowserStubs() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.hasPointerCapture !== 'function') {
    Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
    Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: () => {} })
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: () => {} })
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let route: Awaited<ReturnType<typeof loadUserSettingsRoute>>

beforeAll(async () => {
  route = await loadUserSettingsRoute()
}, 60_000)

let posts: Array<{ body: Record<string, any> }> = []
let counts: { reads: number } = { reads: 0 }
/** While set, a settings GET answers this status (a failed load). */
let failGetsWith: number | null = null
/** While set, a settings GET waits for it (a slow load). */
let holdGets: Promise<void> | null = null

/** The stored record without its stamp: the route restamps `updated_at` on every write. */
async function stored() {
  const record = (await storedUserSettings(USER)) as Record<string, any> | null
  if (!record) return null
  const { updated_at: _stamp, ...rest } = record
  return rest
}

/**
 * The stored record narrowed to the keys `before` holds. The route adds a normalised
 * `voice_settings` block to the record on any save that names settings, which is not the panel's
 * doing: what the panel owns is compared, not that.
 */
async function storedKeysOf(before: Record<string, any>) {
  const record = (await stored()) ?? {}
  return Object.fromEntries(Object.keys(before).map((key) => [key, record[key]]))
}

/** Seeds the saved record; answers what the store holds for it (the baseline of every check). */
async function seedStored() {
  await redis.updateUserSettings(USER, { ...SAVED, avatar_icon_ref: { ...SAVED.avatar_icon_ref } } as any)
  return (await stored()) as Record<string, any>
}

function installRoutes() {
  failGetsWith = null
  holdGets = null
  const installed = installUserSettingsRoutes({
    userId: USER,
    route,
    failGetsWith: () => failGetsWith,
    holdGets: () => holdGets
  })
  posts = installed.posts
  counts = installed.counts
}

function renderPanel(userSettings: unknown = null) {
  return render(UserSettingsPanel, {
    props: { data: { user: { id: USER, email: 'fixture@example.invalid' }, userSettings } as any }
  })
}

/** The first read left the browser and the panel's own loading line is gone. */
async function loadSettled() {
  await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
  await waitFor(() => expect(screen.queryByText('Loading settings…')).toBeNull(), { timeout: 10_000 })
}

const nameInput = () => screen.queryByLabelText('Display Name') as HTMLInputElement | null
const busyTrigger = () => screen.queryByTestId('busy-send-mode-trigger')
const removeAvatarButton = () => screen.queryByRole('button', { name: 'Remove Avatar' })
const promptButton = () => screen.queryByRole('button', { name: /^(Create|Edit) Global System Prompt/ })
const loadNotice = () => screen.queryByTestId('user-settings-load-error')

/** Types a new name, as whatever the panel offers (nothing to type into: nothing happens). */
async function tryToRename(value = 'Joshua') {
  const input = nameInput()
  if (input) await fireEvent.input(input, { target: { value } })
  await pause(SAVE_DEBOUNCE_PAST)
}

async function tryToRemoveTheAvatar() {
  const button = removeAvatarButton()
  if (button) await fireEvent.click(button)
  await pause(SAVE_DEBOUNCE_PAST)
}

/** Picks a busy-send mode from the real Select (Bits UI opens from the keyboard in jsdom). */
async function tryToPickBusyMode(label: string) {
  const trigger = busyTrigger()
  if (trigger) {
    trigger.focus()
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const option = await waitFor(
      () => {
        const found = Array.from(document.querySelectorAll('[role="option"]')).find((node) =>
          (node.textContent ?? '').includes(label)
        )
        expect(found).toBeTruthy()
        return found as HTMLElement
      },
      { timeout: 5_000 }
    )
    await fireEvent.pointerUp(option, { button: 0, pointerType: 'mouse' })
  }
  await pause(SAVE_DEBOUNCE_PAST)
}

/** Opens the Global System Prompt editor, types, and saves, as far as the panel offers it. */
async function tryToSaveAPrompt(value = 'A prompt typed in a hurry.') {
  const button = promptButton()
  if (button) {
    await fireEvent.click(button)
    const textarea = await screen.findByPlaceholderText('Enter system prompt...')
    await fireEvent.input(textarea, { target: { value } })
    await fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
  }
  await pause(SAVE_DEBOUNCE_PAST)
}

describe('User Settings never turns a failed load into a save (BL-962)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  // Every writer of the record, each with the read failing: nothing leaves, nothing is stored.
  describe.each([
    ['the page carries no copy (the defaults)', null],
    ['the page carries an older copy', PAGE_COPY]
  ])('the load fails and %s', (_name, pageCopy) => {
    it('a new name (the autosave): no write leaves and the stored settings are unchanged', async () => {
      const before = await seedStored()
      installRoutes()
      failGetsWith = 500
      renderPanel(pageCopy)
      await loadSettled()

      await tryToRename()

      expect(posts).toEqual([])
      expect(await stored()).toEqual(before)
    }, 60_000)
  })

  it('the load fails: an avatar removed (the autosave) sends nothing and the stored settings are unchanged', async () => {
    const before = await seedStored()
    installRoutes()
    failGetsWith = 500
    renderPanel(PAGE_COPY)
    await loadSettled()

    await tryToRemoveTheAvatar()

    expect(posts).toEqual([])
    expect(await stored()).toEqual(before)
  }, 60_000)

  it('the load fails: a busy-send mode picked (the autosave) sends nothing and the stored settings are unchanged', async () => {
    const before = await seedStored()
    installRoutes()
    failGetsWith = 500
    renderPanel(PAGE_COPY)
    await loadSettled()

    // The page's copy shows Steer; the user picks the other word.
    await tryToPickBusyMode('Queue')

    expect(posts).toEqual([])
    expect(await stored()).toEqual(before)
  }, 60_000)

  it('the load fails: a Global System Prompt saved from the editor sends nothing and the stored settings are unchanged', async () => {
    const before = await seedStored()
    installRoutes()
    failGetsWith = 500
    renderPanel(PAGE_COPY)
    await loadSettled()

    await tryToSaveAPrompt()

    expect(posts).toEqual([])
    expect(await stored()).toEqual(before)
  }, 60_000)

  it('the load fails: the panel says so in plain words with a Retry, and offers no field that looks saved', async () => {
    await seedStored()
    installRoutes()
    failGetsWith = 500
    renderPanel(PAGE_COPY)
    const notice = await screen.findByTestId('user-settings-load-error', undefined, { timeout: 10_000 })

    expect(
      within(notice).getByText(
        /User settings could not load, so the Profile, Global System Prompt, and Chat cards are hidden\. Press Retry to load them\./
      )
    ).toBeTruthy()
    // The route's own message follows the plain sentence.
    expect(notice.textContent).toContain('Redis unavailable')
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(nameInput()).toBeNull()
    expect(busyTrigger()).toBeNull()
    expect(removeAvatarButton()).toBeNull()
    expect(promptButton()).toBeNull()
    // What is not a saved value stays: the panel's title, and Log Out (a failed read may be an
    // ended session).
    expect(screen.getByText('User Settings')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Log Out/ })).toBeTruthy()
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a slow load: an edit before it landed writes nothing, and after it landed the fields show the saved values', async () => {
    const before = await seedStored()
    installRoutes()
    let release: () => void = () => {}
    holdGets = new Promise<void>((resolve) => {
      release = resolve
    })
    renderPanel(PAGE_COPY)
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await pause(300)

    // Not editable until the load landed: the fields are not there, a plain line stands in.
    expect(screen.getByText('Loading settings…')).toBeTruthy()
    await tryToRename()
    await tryToSaveAPrompt()
    expect(nameInput()).toBeNull()
    expect(posts).toEqual([])
    expect(await stored()).toEqual(before)

    holdGets = null
    release()
    await waitFor(() => expect(nameInput()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByText('Loading settings…')).toBeNull()
    expect(nameInput()?.value).toBe('Josh')
    await pause(SAVE_DEBOUNCE_PAST)

    expect(posts).toEqual([])
    expect(await stored()).toEqual(before)
  }, 60_000)

  it('the load fails and Retry works: the fields show the saved values (not the page copy), one edit saves, and every other saved value stays', async () => {
    const before = await seedStored()
    installRoutes()
    failGetsWith = 500
    renderPanel(PAGE_COPY)
    const notice = await screen.findByTestId('user-settings-load-error', undefined, { timeout: 10_000 })

    // A Retry that fails again changes nothing: the notice stays, and nothing is written.
    const readsBefore = counts.reads
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(counts.reads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    await pause(300)
    expect(loadNotice()).not.toBeNull()
    expect(nameInput()).toBeNull()
    expect(posts).toEqual([])
    // The failed Retry is over, so the button is free for the next press.
    expect(
      within(loadNotice() as HTMLElement).getByRole('button', { name: /Retry/ }).hasAttribute('disabled')
    ).toBe(false)

    // A Retry that works clears the notice and shows what is saved, not the page's older copy.
    failGetsWith = null
    await fireEvent.click(within(loadNotice() as HTMLElement).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(nameInput()).not.toBeNull(), { timeout: 10_000 })
    expect(loadNotice()).toBeNull()
    expect(nameInput()?.value).toBe('Josh')
    expect((busyTrigger()?.textContent ?? '').trim()).toBe('Queue')
    expect(promptButton()?.textContent).toContain('Edit Global System Prompt')
    expect(removeAvatarButton()).not.toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await stored()).toEqual(before)

    // One edit saves that one change; every other saved value stays.
    await tryToRename('Joshua')
    expect(posts.length).toBe(1)
    // What the panel sends for one edit is what it sent before: the six keys it owns.
    expect(Object.keys(posts[0].body).sort()).toEqual([...SENT_KEYS].sort())
    expect(await storedKeysOf(before)).toEqual({ ...before, displayName: 'Joshua' })
  }, 60_000)

  it('the load fails and Retry works: the Global System Prompt editor saves the prompt and keeps the saved avatar and busy-send mode', async () => {
    const before = await seedStored()
    installRoutes()
    failGetsWith = 500
    renderPanel(PAGE_COPY)
    const notice = await screen.findByTestId('user-settings-load-error', undefined, { timeout: 10_000 })
    failGetsWith = null
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(promptButton()).not.toBeNull(), { timeout: 10_000 })
    expect(posts).toEqual([])

    await tryToSaveAPrompt('A prompt typed on purpose.')

    expect(posts.length).toBe(1)
    expect(await storedKeysOf(before)).toEqual({
      ...before,
      global_custom_system_prompt: 'A prompt typed on purpose.'
    })
  }, 60_000)

  it('a read that succeeds and says there is no record opens with the defaults, never with the page copy', async () => {
    installRoutes()
    // The page holds a copy, but the read answered: no record. The read is the only source.
    renderPanel(PAGE_COPY)
    await waitFor(() => expect(nameInput()).not.toBeNull(), { timeout: 10_000 })

    expect(loadNotice()).toBeNull()
    expect(nameInput()?.value).toBe('')
    expect((busyTrigger()?.textContent ?? '').trim()).toBe('Steer')
    expect(promptButton()?.textContent).toContain('Create Global System Prompt')
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await stored()).toBeNull()
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a normal open writes nothing and a normal edit saves as before', async () => {
    const before = await seedStored()
    installRoutes()
    renderPanel()
    await waitFor(() => expect(nameInput()?.value).toBe('Josh'), { timeout: 10_000 })
    expect(loadNotice()).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await stored()).toEqual(before)

    await tryToRename('Joshua')
    expect(posts.length).toBe(1)
    expect(await storedKeysOf(before)).toEqual({ ...before, displayName: 'Joshua' })
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a user with no saved settings yet opens the panel, and the first edit saves the defaults plus that edit', async () => {
    installRoutes()
    renderPanel()
    await waitFor(() => expect(nameInput()).not.toBeNull(), { timeout: 10_000 })
    expect(loadNotice()).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    await tryToRename('Joshua')
    expect(posts.length).toBe(1)
    const record = await stored()
    expect(record?.displayName).toBe('Joshua')
    expect(record?.global_chat_settings).toEqual({ busy_send_mode: 'steer' })
    expect(record?.global_custom_system_prompt).toBe('')
  }, 60_000)
})
