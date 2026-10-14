import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import SettingsTextEditor from './SettingsTextEditor.svelte'

/**
 * BL-816: `SettingsTextEditor` took its draft from `value` in an effect that also read `value`, so
 * any change to the saved value while the editor was open (another window, an agent, a background
 * refresh) replaced what the user was typing, with no word. It also cleared `isSaving` mid-save.
 *
 * The draft is now taken when the editor OPENS. While it is open a changed saved value is followed
 * only when the user has not edited; an edited draft is kept and the editor says the saved value
 * changed and that saving replaces it.
 *
 * Renders the REAL component; `rerender` plays the parent handing down a new saved value.
 */

const NOTICE = 'settings-text-editor-saved-value-changed'

type Props = {
  open: boolean
  value: string
  readOnly?: boolean
  onSave?: (value: string) => void | Promise<void>
  onCancel?: () => void
}

function mountEditor(props: Partial<Props> = {}) {
  const rendered = render(SettingsTextEditor, {
    props: { open: true, title: 'Prompt', value: 'alpha', ...props }
  })
  const textarea = () => screen.getByRole('textbox') as HTMLTextAreaElement
  const type = async (text: string) => {
    await fireEvent.input(textarea(), { target: { value: text } })
    await tick()
  }
  const setSaved = async (value: string) => {
    await rendered.rerender({ value })
    await tick()
  }
  return { ...rendered, textarea, type, setSaved }
}

describe('SettingsTextEditor keeps what the user is typing (BL-816)', () => {
  it('opens on the saved value with no notice', () => {
    const { textarea } = mountEditor()
    expect(textarea().value).toBe('alpha')
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('No changes')).toBeTruthy()
  })

  it('keeps a typed draft when the saved value changes, and says so', async () => {
    const { textarea, type, setSaved } = mountEditor()
    await type('alpha, edited by hand')

    await setSaved('beta')

    expect(textarea().value).toBe('alpha, edited by hand')
    const notice = screen.getByTestId(NOTICE)
    expect(notice.className).toContain('batshit-settings-inline-alert')
    expect(notice.className).toContain('is-warning')
    expect(notice.textContent).toContain('saved value changed while you were editing')
    expect(notice.textContent).toContain('replaces')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })

  it('keeps every later keystroke after the saved value changed', async () => {
    const { textarea, type, setSaved } = mountEditor()
    await type('alpha 1')
    await setSaved('beta')
    await type('alpha 12')
    await type('alpha 123')
    expect(textarea().value).toBe('alpha 123')
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
  })

  it('follows a changed saved value while the user has not edited', async () => {
    const { textarea, setSaved } = mountEditor()

    await setSaved('beta')
    expect(textarea().value).toBe('beta')
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('No changes')).toBeTruthy()

    await setSaved('gamma')
    expect(textarea().value).toBe('gamma')
  })

  it('follows when the user typed and then put the opening text back', async () => {
    const { textarea, type, setSaved } = mountEditor()
    await type('alpha and more')
    await type('alpha')

    await setSaved('beta')

    expect(textarea().value).toBe('beta')
    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })

  it('keeps a draft the user types back to the opening text after the saved value changed', async () => {
    const { textarea, type, setSaved } = mountEditor()
    await type('draft')
    await setSaved('beta')

    // Typing does not re-run the editor's own effect against the new saved value.
    await type('alpha')

    expect(textarea().value).toBe('alpha')
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })

  it('drops the notice when the draft equals the saved value again', async () => {
    const { type, setSaved } = mountEditor()
    await type('draft')
    await setSaved('beta')
    expect(screen.getByTestId(NOTICE)).toBeTruthy()

    await type('beta')

    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('No changes')).toBeTruthy()
  })

  it('drops the notice when the saved value goes back to the one the editor opened with', async () => {
    const { textarea, type, setSaved } = mountEditor()
    await type('draft')
    await setSaved('beta')
    expect(screen.getByTestId(NOTICE)).toBeTruthy()

    await setSaved('alpha')

    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(textarea().value).toBe('draft')
  })

  it('saves the kept draft over the changed saved value', async () => {
    const onSave = vi.fn()
    const { type, setSaved } = mountEditor({ onSave })
    await type('my text')
    await setSaved('beta')

    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith('my text')
  })

  it('Cancel resets the draft to the current saved value and closes', async () => {
    const onCancel = vi.fn()
    const { textarea, type, setSaved } = mountEditor({ onCancel })
    await type('my text')
    await setSaved('beta')
    const field = textarea()
    expect(field.value).toBe('my text')

    await fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await tick()

    // Read from the field itself, before any reopen: opening resets the draft too, so a reopen
    // could not tell whether Cancel did its own reset.
    expect(field.value).toBe('beta')
    expect(onCancel).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  })

  it('takes the current saved value when it is closed and opened again', async () => {
    const { rerender, textarea, type, setSaved } = mountEditor()
    await type('abandoned draft')
    await setSaved('beta')
    expect(screen.getByTestId(NOTICE)).toBeTruthy()

    await rerender({ open: false })
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    await setSaved('gamma')
    await rerender({ open: true })

    await waitFor(() => expect(textarea().value).toBe('gamma'))
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('No changes')).toBeTruthy()
  })

  it('leaves a save in flight showing Saving when the saved value changes under it', async () => {
    let finishSave: () => void = () => {}
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        })
    )
    const { type, setSaved } = mountEditor({ onSave })
    await type('my text')
    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(screen.getByText('Saving...')).toBeTruthy())

    await setSaved('my text')

    expect(screen.getByText('Saving...')).toBeTruthy()
    expect((screen.getByRole('button', { name: /saving/i }) as HTMLButtonElement).disabled).toBe(true)
    finishSave()
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  })

  it('does not warn about the saved value its own save changed, but does after a refused save', async () => {
    let refuseSave: (error: Error) => void = () => {}
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuseSave = reject
        })
    )
    const { textarea, type, setSaved } = mountEditor({ onSave })
    await type('my text ')
    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(screen.getByText('Saving...')).toBeTruthy())

    await setSaved('my text')
    expect(screen.queryByTestId(NOTICE)).toBeNull()

    refuseSave(new Error('Save refused'))
    await waitFor(() => expect(screen.getByText('Save refused')).toBeTruthy())
    expect(textarea().value).toBe('my text ')
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
  })

  it('read-only: follows the saved value and never shows the notice', async () => {
    const { textarea, setSaved } = mountEditor({ readOnly: true })
    expect(textarea().readOnly).toBe(true)

    await setSaved('beta')

    expect(textarea().value).toBe('beta')
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull()
  })
})

/**
 * BL-891: the editor used to listen for the save key and Escape on the WINDOW, and a panel mounts
 * several editors at once (Agent Settings keeps eight). A closed editor's draft starts empty and
 * takes the saved value only when it opens, so the save key in ONE open editor made every CLOSED
 * editor call its save with an empty draft (an Always Block List or a prompt stored empty), and
 * Escape ran each closed editor's cancel. The keys are now heard by the editor's own sheet: a
 * key typed in the open editor acts on that editor only. The tests press keys on the textarea, the
 * way a real key press reaches the page.
 */
describe('SettingsTextEditor keys act only on their own editor (BL-891)', () => {
  function mountClosed(props: Partial<Props> = {}) {
    render(SettingsTextEditor, { props: { open: false, title: 'Other prompt', value: 'beta', ...props } })
  }

  it('the save key in the open editor saves it, and never calls a closed editor\'s save', async () => {
    const openSave = vi.fn()
    const closedSave = vi.fn()
    const open = mountEditor({ open: true, value: 'alpha', onSave: openSave })
    mountClosed({ onSave: closedSave })
    await open.type('alpha, edited')

    await fireEvent.keyDown(open.textarea(), { key: 's', metaKey: true })
    await tick()

    expect(openSave).toHaveBeenCalledTimes(1)
    expect(openSave).toHaveBeenCalledWith('alpha, edited')
    expect(closedSave).not.toHaveBeenCalled()
  })

  it('the Ctrl+S form of the save key is the same', async () => {
    const openSave = vi.fn()
    const closedSave = vi.fn()
    const open = mountEditor({ open: true, value: 'alpha', onSave: openSave })
    mountClosed({ onSave: closedSave })
    await open.type('alpha, edited')

    await fireEvent.keyDown(open.textarea(), { key: 's', ctrlKey: true })
    await tick()

    expect(openSave).toHaveBeenCalledTimes(1)
    expect(closedSave).not.toHaveBeenCalled()
  })

  it('Escape in the open editor runs its own cancel once, and never a closed editor\'s cancel', async () => {
    const openCancel = vi.fn()
    const closedCancel = vi.fn()
    const open = mountEditor({ open: true, value: 'alpha', onCancel: openCancel })
    mountClosed({ onCancel: closedCancel })

    await fireEvent.keyDown(open.textarea(), { key: 'Escape' })
    await tick()

    expect(openCancel).toHaveBeenCalledTimes(1)
    expect(closedCancel).not.toHaveBeenCalled()
  })

  it('a key that is not typed in an editor saves and cancels nothing, closed or open', async () => {
    const openSave = vi.fn()
    const openCancel = vi.fn()
    const closedSave = vi.fn()
    const closedCancel = vi.fn()
    const open = mountEditor({ open: true, value: 'alpha', onSave: openSave, onCancel: openCancel })
    mountClosed({ onSave: closedSave, onCancel: closedCancel })
    await open.type('alpha, edited')

    await fireEvent.keyDown(window, { key: 's', metaKey: true })
    await fireEvent.keyDown(window, { key: 'Escape' })
    await tick()

    expect(openSave).not.toHaveBeenCalled()
    expect(openCancel).not.toHaveBeenCalled()
    expect(closedSave).not.toHaveBeenCalled()
    expect(closedCancel).not.toHaveBeenCalled()
  })

  it('a closed editor ignores the save key on its own', async () => {
    const onSave = vi.fn()
    mountClosed({ onSave })

    await fireEvent.keyDown(document.body, { key: 's', metaKey: true })
    await tick()

    expect(onSave).not.toHaveBeenCalled()
  })
})
