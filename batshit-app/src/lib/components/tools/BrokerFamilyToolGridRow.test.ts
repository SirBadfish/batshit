import { render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

import BrokerFamilyToolGridRow from './BrokerFamilyToolGridRow.svelte'
import type { BrokerFamilyRowControls } from './brokerFamilyRowControls'

/**
 * SA-096: `BrokerFamilyDiscoverabilityCells` emits bare `<td>` elements from inside a
 * component boundary, which is the one structurally risky thing about sharing the cells
 * between the standalone row and the `Batshit Tools` rows. If Svelte ever built that
 * fragment through an HTML string, the parser's table rules would drop the cells and the
 * controls would silently vanish from the grid. These tests fail loudly if that happens.
 */

function buildControls(overrides: Partial<BrokerFamilyRowControls> = {}): BrokerFamilyRowControls {
  return {
    label: 'Fabric Controls',
    iconRef: { kind: 'batshit', id: 'fabric' },
    visible: true,
    value: 'group-only',
    iconMode: 'group-only',
    options: [
      { value: 'use-global', label: 'Use global' },
      { value: 'group-only', label: 'Show group only' }
    ],
    optionIconMode: () => 'group-only',
    modeLabel: (value) => `Mode ${value}`,
    infoParagraphs: ['Fabric controls are Batshit-native app actions.'],
    onVisibleChange: vi.fn(),
    onModeChange: vi.fn(),
    ...overrides
  }
}

// A `<tr>` needs a real table ancestor to survive, so each case builds one and attaches
// it so `screen` queries can reach the row. Anything attached here is removed again in
// afterEach: leaving detached tables on document.body outlives the jsdom environment and
// makes teardown fail with "document is not defined" once the environment is disposed.
const mountedTables: HTMLTableElement[] = []

afterEach(() => {
  for (const table of mountedTables.splice(0)) {
    table.remove()
  }
})

function renderRow(controls: BrokerFamilyRowControls) {
  const table = document.createElement('table')
  const body = document.createElement('tbody')
  table.appendChild(body)
  document.body.appendChild(table)
  mountedTables.push(table)

  return render(BrokerFamilyToolGridRow, {
    props: { controls, rowClass: 'batshit-settings-table-row' },
    target: body
  })
}

describe('BrokerFamilyToolGridRow', () => {
  it('renders the family label plus both controls as real table cells', () => {
    renderRow(buildControls())

    const row = document.querySelector('tr')
    expect(row).not.toBeNull()

    // Label + Discoverable + Display Detail. A dropped component fragment shows up here
    // as a cell count of 1.
    expect(row?.querySelectorAll('td').length).toBe(3)
    expect(screen.getByRole('switch')).toBeTruthy()
    expect(screen.getByLabelText('Fabric Controls discoverable')).toBeTruthy()
    expect(screen.getByLabelText('Fabric Controls display detail')).toBeTruthy()
  })

  it('keeps the Discoverable cell but drops the detail select when the family is hidden', () => {
    renderRow(buildControls({ visible: false }))

    const row = document.querySelector('tr')
    expect(row?.querySelectorAll('td').length).toBe(3)
    expect(screen.getByLabelText('Fabric Controls discoverable')).toBeTruthy()
    expect(screen.queryByLabelText('Fabric Controls display detail')).toBeNull()
  })

  it('reports discoverability changes to the caller', async () => {
    const onVisibleChange = vi.fn()
    renderRow(buildControls({ onVisibleChange }))

    const toggle = screen.getByLabelText('Fabric Controls discoverable') as HTMLElement
    toggle.click()

    expect(onVisibleChange).toHaveBeenCalledWith(false)
  })
})
