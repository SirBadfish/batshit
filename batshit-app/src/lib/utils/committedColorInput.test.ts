import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { committedColorInput } from './committedColorInput'

describe('committedColorInput', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const node = document.createElement('input')
    node.type = 'color'
    node.value = '#ffffff'
    const onCommit = vi.fn()
    const action = committedColorInput(node, { value: '#ffffff', onCommit })
    const input = (color: string, event = 'input') => {
      node.value = color
      node.dispatchEvent(new Event(event))
    }
    return { node, onCommit, action, input }
  }

  it('keeps the picker responsive and emits only the latest color after dragging settles', () => {
    const { node, onCommit, action, input } = setup()
    for (const color of ['#112233', '#223344', '#334455']) {
      input(color)
      vi.advanceTimersByTime(200)
      expect(node.value).toBe(color)
      expect(onCommit).not.toHaveBeenCalled()
    }
    vi.advanceTimersByTime(50)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('#334455')
    action.destroy()
  })

  it.each(['change', 'blur'])('flushes a final %s immediately without a duplicate timer or closing event', (event) => {
    const { node, onCommit, action, input } = setup()
    input('#112233')
    node.dispatchEvent(new Event(event))
    vi.advanceTimersByTime(1000)
    node.dispatchEvent(new Event('change'))
    node.dispatchEvent(new Event('blur'))
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('#112233')
    action.destroy()
  })

  it('handles a committed picker value without an input event', () => {
    const { onCommit, action, input } = setup()
    input('#112233', 'change')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('#112233')
    action.destroy()
  })

  it('cancels pending colors when an external preset or reset replaces the value', () => {
    const { node, onCommit, action, input } = setup()
    input('#112233')
    action.update({ value: '#ABCDEF', onCommit })
    vi.advanceTimersByTime(1000)
    node.dispatchEvent(new Event('change'))
    expect(node.value).toBe('#abcdef')
    expect(onCommit).not.toHaveBeenCalled()
    action.destroy()
  })

  it('cancels pending colors when disabled and does not replay them on re-enable', () => {
    const { onCommit, action, input } = setup()
    input('#112233')
    action.update({ value: '#ffffff', disabled: true, onCommit })
    input('#223344')
    action.update({ value: '#ffffff', onCommit })
    vi.advanceTimersByTime(1000)
    expect(onCommit).not.toHaveBeenCalled()
    action.destroy()
  })

  it('cancels a pending drag when the item or reset changes but its saved color stays the same', () => {
    const { node, onCommit, action, input } = setup()
    input('#112233')
    action.update({ value: '#ffffff', resetKey: {}, onCommit })
    vi.advanceTimersByTime(1000)
    node.dispatchEvent(new Event('change'))
    expect(onCommit).not.toHaveBeenCalled()
    action.destroy()
  })

  it('preserves a newer drag when the parent acknowledges the previous asynchronous commit', () => {
    const { node, onCommit, action, input } = setup()
    input('#112233')
    vi.advanceTimersByTime(250)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('#112233')
    input('#223344')
    vi.advanceTimersByTime(100)
    // Svelte updates the native value before the action receives the acknowledged state.
    node.value = '#112233'
    action.update({ value: '#112233', resetKey: {}, onCommit })
    expect(node.value).toBe('#223344')
    vi.advanceTimersByTime(150)
    expect(onCommit.mock.calls).toEqual([['#112233'], ['#223344']])
    action.destroy()
  })

  it('still discards a pending drag on a later explicit reset to an already acknowledged color', () => {
    const { node, onCommit, action, input } = setup()
    input('#112233', 'change')
    action.update({ value: '#112233', resetKey: {}, onCommit })
    input('#223344')
    action.update({ value: '#112233', resetKey: {}, onCommit })
    vi.advanceTimersByTime(1000)
    expect(node.value).toBe('#112233')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('#112233')
    action.destroy()
  })

  it('uses the latest callback without dropping a pending color on an unrelated redraw', () => {
    const { onCommit, action, input } = setup()
    const latest = vi.fn()
    input('#112233')
    action.update({ value: '#ffffff', onCommit: latest })
    vi.advanceTimersByTime(250)
    expect(onCommit).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledExactlyOnceWith('#112233')
    action.destroy()
  })

  it('cancels pending colors and removes listeners on destruction', () => {
    const { onCommit, action, input } = setup()
    input('#112233')
    action.destroy()
    input('#223344', 'change')
    vi.advanceTimersByTime(1000)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
