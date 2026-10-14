import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'
import CodeRenderer from '../CodeRenderer.svelte'
import TerminalRenderer from '../TerminalRenderer.svelte'
import DefaultToolRenderer from '../../tools/DefaultToolRenderer.svelte'

// Found in BL-169: the code and terminal blocks said "1 lines" for one line.
describe('a count of one is singular on code and terminal blocks', () => {
  it('says "1 line" on a one-line code block', () => {
    const { container } = render(CodeRenderer as any, { props: { content: 'const one = 1', language: 'javascript' } })
    const subtitle = container.querySelector('.subtitle')?.textContent ?? ''

    expect(subtitle).toContain('1 line')
    expect(subtitle).not.toContain('1 lines')
  })

  it('says "1 line" on a one-line terminal block', () => {
    const { container } = render(TerminalRenderer as any, { props: { content: 'hello' } })
    const subtitle = container.querySelector('.subtitle')?.textContent ?? ''

    expect(subtitle).toBe('1 line')
  })

  it('says "1 item" on the fallback tool card for a one-item result', () => {
    const { container } = render(DefaultToolRenderer as any, {
      props: { tool: { toolName: 'zbcards_unknown_tool', toolInput: {}, toolResult: [{ a: 1 }], success: true } }
    })
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')

    expect(text).toContain('1 item')
    expect(text).not.toContain('1 items')
  })

  it('still says "2 lines" for two', () => {
    const { container } = render(TerminalRenderer as any, { props: { content: 'hello\nworld' } })

    expect(container.querySelector('.subtitle')?.textContent).toBe('2 lines')
  })
})
