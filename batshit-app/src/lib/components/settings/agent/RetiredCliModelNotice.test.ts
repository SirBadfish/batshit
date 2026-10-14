import { render } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import RetiredCliModelNotice from './RetiredCliModelNotice.svelte'

describe('BL-158: the notice under a CLI model picker', () => {
  it('flags a saved Codex model that left the list', () => {
    const { getByTestId } = render(RetiredCliModelNotice, { props: { runtime: 'codex', model: 'gpt-5.4' } })
    const notice = getByTestId('retired-cli-model-notice')
    expect(notice.textContent).toContain("GPT-5.4 left Batshit's Codex list on 2026-09-06")
    expect(notice.textContent).toContain('Pick another model')
    expect(notice.className).toContain('is-warning')
  })

  it('shows nothing for a listed model, an empty one, or one Batshit never listed', () => {
    for (const model of ['gpt-6-astra', 'gpt-7-typed-by-hand', '', null]) {
      const { queryByTestId, unmount } = render(RetiredCliModelNotice, { props: { runtime: 'codex', model } })
      expect(queryByTestId('retired-cli-model-notice'), String(model)).toBeNull()
      unmount()
    }
    const { queryByTestId } = render(RetiredCliModelNotice, { props: { runtime: 'claude', model: 'opus' } })
    expect(queryByTestId('retired-cli-model-notice')).toBeNull()
  })
})
