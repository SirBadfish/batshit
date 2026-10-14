import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/svelte'
import { page } from '$app/state'
import * as messageStore from '$lib/stores/messages.svelte'
import { setUserSettings } from '$lib/stores/userSettings.svelte'
import type { Message } from '$lib/stores/messages.svelte'

/**
 * BL-240: the user's own bubble says the name they set, not "Me".
 *
 * Setup (`auth.server.ts`) and the User settings panel save the name as `displayName`, and every
 * other surface (the sidebar, the Markdown export, the group roster) reads that field. The chat
 * read `display_name`, a field no settings writer sets, so every user bubble said "Me" and the
 * avatar initials came from the email. Drives the REAL `ChatMessage` from the REAL message store.
 */

const Harness = (await import('./ChatMessageApprovalHarness.test.svelte')).default

const SESSION = 'session-user-name'
const USER_MESSAGE = 'msg_user_name'
const pageData = page.data as Record<string, unknown>

function seedUserMessage() {
  messageStore.setMessagesForSession(SESSION, [
    {
      id: USER_MESSAGE,
      role: 'user',
      content: 'Hello there.',
      session_id: SESSION,
      status: 'complete',
      created_at: new Date().toISOString()
    }
  ] as unknown as Message[])
}

function renderUserMessage(userSettings: Record<string, unknown> | undefined) {
  pageData.userSettings = userSettings
  seedUserMessage()
  render(Harness, { props: { messageId: USER_MESSAGE, sessionId: SESSION } })
  return {
    name: () => document.querySelector('.message-shell.is-user .message-name')?.textContent?.trim(),
    // The default avatar image shows first; its load error is what reveals the initials.
    initials: async () => {
      const image = document.querySelector('.message-shell.is-user .message-avatar-user img')
      if (image) await fireEvent.error(image)
      return document.querySelector('.message-shell.is-user .message-avatar-fallback')?.textContent?.trim()
    }
  }
}

afterEach(() => {
  delete pageData.userSettings
  setUserSettings(null)
  messageStore.setMessagesForSession(SESSION, [])
})

describe('ChatMessage: the user label (BL-240)', () => {
  it('shows the name saved as displayName, and its initials', async () => {
    const view = renderUserMessage({ displayName: 'Josh Alterman', email: 'someone@example.com' })

    expect(view.name()).toBe('Josh Alterman')
    expect(await view.initials()).toBe('JA')
  })

  it('still reads an old record that holds display_name', async () => {
    const view = renderUserMessage({ display_name: 'Sadie Rae', email: 'someone@example.com' })

    expect(view.name()).toBe('Sadie Rae')
    expect(await view.initials()).toBe('SR')
  })

  it('prefers displayName when a record holds both', () => {
    const view = renderUserMessage({ displayName: 'Josh Alterman', display_name: 'Old Name' })

    expect(view.name()).toBe('Josh Alterman')
  })

  it('says "Me" and takes initials from the email when no name is set', async () => {
    const view = renderUserMessage({ displayName: '   ', email: 'someone@example.com' })

    expect(view.name()).toBe('Me')
    expect(await view.initials()).toBe('S')
  })

  // Review of the batch: the page data is the load-time copy; Settings saves through the store.
  it('follows a rename saved in Settings into a bubble already on screen', async () => {
    setUserSettings({ displayName: 'Josh' } as any)
    const view = renderUserMessage({ displayName: 'Load-time Name' })
    expect(view.name()).toBe('Josh')

    setUserSettings({ displayName: 'Joshua' } as any)

    await waitFor(() => expect(view.name()).toBe('Joshua'))
  })
})
