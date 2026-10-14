import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import SystemPromptEditor from './SystemPromptEditor.svelte'

/**
 * BL-891 (the sibling of `SettingsTextEditor`): this editor also heard the save key and Escape on
 * the WINDOW, and five files mount it. A closed editor's draft is what its prompt was when it was
 * last open, so a prompt that changed while it was closed (another window, a refresh) leaves it
 * with an older draft: the save key in ANOTHER open editor made it call its save with that older
 * text, and Escape ran its cancel. The keys are now heard by the editor's own sheet. The tests press
 * keys on the textarea, the way a real key press reaches the page.
 */

describe('SystemPromptEditor keys act only on their own editor (BL-891)', () => {
  it('the save key in the open editor saves it, and never calls a closed editor\'s save with its older draft', async () => {
    const openSave = vi.fn()
    const closedSave = vi.fn()
    render(SystemPromptEditor, { props: { open: true, title: 'Open prompt', prompt: 'alpha', onSave: openSave } })
    const closed = render(SystemPromptEditor, {
      props: { open: false, title: 'Closed prompt', prompt: 'first', onSave: closedSave }
    })
    // The closed editor's saved prompt changes while it is closed: its draft is now older.
    await closed.rerender({ prompt: 'second' })
    await tick()
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    await fireEvent.input(textarea, { target: { value: 'alpha, edited' } })
    await tick()

    await fireEvent.keyDown(textarea, { key: 's', metaKey: true })
    await tick()

    expect(openSave).toHaveBeenCalledTimes(1)
    expect(openSave).toHaveBeenCalledWith('alpha, edited')
    expect(closedSave).not.toHaveBeenCalled()
  })

  it('Escape in the open editor runs its own cancel once, and never a closed editor\'s cancel', async () => {
    const openCancel = vi.fn()
    const closedCancel = vi.fn()
    render(SystemPromptEditor, { props: { open: true, title: 'Open prompt', prompt: 'alpha', onCancel: openCancel } })
    render(SystemPromptEditor, {
      props: { open: false, title: 'Closed prompt', prompt: 'beta', onCancel: closedCancel }
    })

    await fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    await tick()

    expect(openCancel).toHaveBeenCalledTimes(1)
    expect(closedCancel).not.toHaveBeenCalled()
  })

  it('a key that is not typed in an editor saves and cancels nothing, closed or open', async () => {
    const openSave = vi.fn()
    const openCancel = vi.fn()
    const closedSave = vi.fn()
    const closedCancel = vi.fn()
    render(SystemPromptEditor, {
      props: { open: true, title: 'Open prompt', prompt: 'alpha', onSave: openSave, onCancel: openCancel }
    })
    const closed = render(SystemPromptEditor, {
      props: { open: false, title: 'Closed prompt', prompt: 'first', onSave: closedSave, onCancel: closedCancel }
    })
    await closed.rerender({ prompt: 'second' })
    await tick()

    await fireEvent.keyDown(window, { key: 's', metaKey: true })
    await fireEvent.keyDown(window, { key: 'Escape' })
    await tick()

    expect(openSave).not.toHaveBeenCalled()
    expect(openCancel).not.toHaveBeenCalled()
    expect(closedSave).not.toHaveBeenCalled()
    expect(closedCancel).not.toHaveBeenCalled()
  })
})

/**
 * BL-894 (BL-816's bug in this editor): the draft was taken in an effect that also read `prompt`, so a
 * saved prompt that changed while the editor was open (another window, a refresh) replaced what the
 * user was typing, with no word. The draft is now taken when the editor OPENS; while it is open a
 * changed saved prompt is followed only when the draft is untouched, and an edited draft is kept with
 * a warning that the saved prompt changed and that saving replaces it.
 */
describe('SystemPromptEditor keeps what the user is typing (BL-894)', () => {
  const NOTICE = 'system-prompt-editor-saved-value-changed'
  const mount = (props: Record<string, unknown> = {}) =>
    render(SystemPromptEditor, { props: { open: true, title: 'Prompt', prompt: 'alpha', ...props } })
  const textarea = () => screen.getByRole('textbox') as HTMLTextAreaElement
  const type = async (text: string) => {
    await fireEvent.input(textarea(), { target: { value: text } })
    await tick()
  }

  it('opens on the saved prompt with no notice', () => {
    mount()
    expect(textarea().value).toBe('alpha')
    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })

  it('keeps a typed draft when the saved prompt changes, and says so', async () => {
    const { rerender } = mount()
    await type('alpha, typed by hand')

    await rerender({ prompt: 'beta' })
    await tick()

    expect(textarea().value).toBe('alpha, typed by hand')
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
  })

  it('keeps every later keystroke after the saved prompt changed', async () => {
    const { rerender } = mount()
    await type('alpha, typed')
    await rerender({ prompt: 'beta' })
    await tick()

    await type('alpha, typed and more')

    expect(textarea().value).toBe('alpha, typed and more')
  })

  it('keeps a draft the user types back to the opening text after the saved prompt changed', async () => {
    const { rerender } = mount()
    await type('alpha, typed')
    await rerender({ prompt: 'beta' })
    await tick()

    await type('alpha')

    expect(textarea().value).toBe('alpha')
  })

  it('follows a changed saved prompt while the user has not edited', async () => {
    const { rerender } = mount()

    await rerender({ prompt: 'beta' })
    await tick()

    expect(textarea().value).toBe('beta')
    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })

  it('drops the notice when the draft equals the saved prompt again', async () => {
    const { rerender } = mount()
    await type('alpha, typed')
    await rerender({ prompt: 'beta' })
    await tick()
    expect(screen.getByTestId(NOTICE)).toBeTruthy()

    await type('beta')

    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })

  it('saves the kept draft over the changed saved prompt', async () => {
    const onSave = vi.fn()
    const { rerender } = mount({ onSave })
    await type('alpha, typed')
    await rerender({ prompt: 'beta' })
    await tick()

    await fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await tick()

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('alpha, typed')
  })

  it('takes the current saved prompt when it is closed and opened again', async () => {
    const { rerender } = mount()
    await type('alpha, typed')
    await rerender({ open: false })
    await rerender({ prompt: 'beta' })
    await tick()

    await rerender({ open: true })
    await tick()

    expect(textarea().value).toBe('beta')
    expect(screen.queryByTestId(NOTICE)).toBeNull()
  })
})
