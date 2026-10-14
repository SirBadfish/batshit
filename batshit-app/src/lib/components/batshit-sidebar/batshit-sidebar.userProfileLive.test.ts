import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import BatshitSidebarHarness from './batshit-sidebar.harness.test.svelte'
import { setUserSettings } from '$lib/stores/userSettings.svelte'

/**
 * BL-485: after a rename or avatar/icon change in Settings > User, the sidebar footer kept
 * the OLD name and picture until a full reload, because it read the layout's page-LOAD
 * `data.userSettings` and the root layout load never re-runs. Fix: read
 * `getUserSettings() ?? data.userSettings` through `$derived` (the `ChatMessage.svelte:372`
 * pattern), so the footer follows the live settings store the moment Settings saves it — the
 * same store `setUserSettings` already writes to and `ChatMessage`'s chat bubbles already read.
 *
 * The sidebar's own session/folder/live-channel wiring is unrelated to this bug and does real
 * network/SSE work on mount, so it is neutralized here: `fetch` answers generically and the
 * user-channel subscription is mocked. What is under test is the footer's reactivity to the
 * shared `userSettings` store, not session loading.
 */

vi.mock('$lib/services/userChannel', () => ({
  startUserChannel: vi.fn(() => () => {}),
  onUserChannelEvent: vi.fn(() => () => {})
}))

// jsdom has no matchMedia; the shared Sidebar primitive's mobile-breakpoint hook needs it.
// Restored after this file's tests so the polyfill doesn't leak into a shared jsdom `window`
// across other test files.
const originalMatchMedia = window.matchMedia
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  }) as unknown as MediaQueryList
}

afterAll(() => {
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia
  } else {
    // @ts-expect-error - jsdom has no matchMedia by default; restore that absence exactly.
    delete window.matchMedia
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  setUserSettings(null)
})

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.startsWith('/api/folders')) return new Response(JSON.stringify([]), { status: 200 })
      if (url.startsWith('/api/sessions')) return new Response(JSON.stringify([]), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    })
  )
}

describe('Sidebar footer follows the live user settings store (BL-485)', () => {
  it('updates the footer name and avatar without a new page-load `data` prop', async () => {
    stubFetch()
    setUserSettings(null)

    render(BatshitSidebarHarness, {
      props: {
        data: {
          user: { id: 'u1', email: 'fixture@example.invalid' },
          userSettings: {
            displayName: 'Josh',
            avatar_url: null,
            avatar_icon_ref: null,
            avatar_icon_fit: 'fill'
          }
        }
      }
    })

    await waitFor(() => expect(screen.getByTestId('open-user-settings-button')).toBeTruthy())
    const footerButton = screen.getByTestId('open-user-settings-button')
    expect(footerButton.textContent).toContain('Josh')
    // No avatar_url yet: the sidebar's own fallback (not EntityAvatar's) shows the generic
    // default picture.
    expect(footerButton.querySelector('img')?.getAttribute('src')).toBe(
      '/assets/batshit_default_User_Avatar.png'
    )

    // Settings > User saves through `setUserSettings` — no new `data` prop, no reload.
    setUserSettings({
      displayName: 'Joshua',
      avatar_url: 'https://example.test/new-avatar.png',
      avatar_icon_ref: null,
      avatar_icon_fit: 'fill'
    })

    await waitFor(() => expect(footerButton.textContent).toContain('Joshua'))
    // The title promises both name AND avatar — prove the picture followed too.
    await waitFor(() => expect(footerButton.querySelector('img')).not.toBeNull())
    expect(footerButton.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/new-avatar.png'
    )
  })
})
