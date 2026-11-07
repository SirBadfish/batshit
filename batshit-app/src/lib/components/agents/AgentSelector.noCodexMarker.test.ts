/**
 * SA-139 R1: Codex CLI was removed. With a Claude CLI agent, an API agent on an OpenAI model id
 * that contains "codex", and a LEFTOVER Codex CLI agent (a stored record R1 does not migrate)
 * listed, neither the selected target nor the open menu shows any Codex marker; the leftover
 * still lists like any agent. SA-139 R3 (decision 16): one Primary concept, so no agent shows an
 * API/CLI type badge either; the menu's role labels are its "Agents" and "Groups" sections.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentStore from '$lib/stores/agents.svelte'

vi.mock('$lib/services/userChannel', () => ({
  startUserChannel: vi.fn(() => () => {}),
  onUserChannelEvent: vi.fn(() => () => {})
}))

import AgentSelector from './AgentSelector.svelte'

const CLAUDE_CLI_AGENT = {
  id: 'claude_cli_agent', user_id: 'selector-user', displayName: 'Bram', agentType: 'cli',
  primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'claude-cli',
  primary_model_connection: { type: 'direct', id: 'claude-cli', service: 'anthropic-claude-cli' },
  claude_settings: { permissionMode: 'default', model: 'claude-opus-5-5' },
  created_at: '', updated_at: ''
}
const API_AGENT = {
  id: 'api_agent', user_id: 'selector-user', displayName: 'Sol', agentType: 'api',
  primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex',
  primary_model_connection: { type: 'direct', id: 'direct:openai', service: 'openai' },
  created_at: '', updated_at: ''
}
/** A stored Codex CLI agent from before R1: never migrated, still listed, never marked "Codex". */
const LEFTOVER_CODEX_CLI_AGENT = {
  id: 'leftover_codex_cli_agent', user_id: 'selector-user', displayName: 'Rook', agentType: 'cli',
  primary_model_provider: 'openai-codex', primary_model_name: 'gpt-5.1-codex',
  primary_model_connection: { id: 'codex-cli', service: 'openai-codex', type: 'direct' },
  created_at: '', updated_at: ''
}

async function openMenu(trigger: HTMLElement) {
  await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  return waitFor(() => {
    const content = document.querySelector('.agent-selector-dropdown') as HTMLElement | null
    expect(content).not.toBeNull()
    return content!
  })
}

function expectNoTypeBadge(element: HTMLElement) {
  expect(element.querySelector('.agent-selector-type-badge, .batshit-agent-type-badge')).toBeNull()
  expect(element.textContent).not.toMatch(/\b(API|CLI)\b/)
}

function expectNoCodexMarker(element: HTMLElement) {
  expect(element.textContent).not.toMatch(/codex/i)
  for (const node of [element, ...element.querySelectorAll('[aria-label], [title]')]) {
    expect(`${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`).not.toMatch(/codex/i)
  }
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null }) })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value() {} })
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value() {} })
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 404 })))
  agentStore.setAgents([CLAUDE_CLI_AGENT, API_AGENT, LEFTOVER_CODEX_CLI_AGENT] as any)
  agentStore.setCurrentAgentId(CLAUDE_CLI_AGENT.id)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  agentStore.setAgents([])
  agentStore.setCurrentAgentId(null)
})

describe('SA-139 R1: the chat-target selector shows no Codex marker', () => {
  it('in the selected target and in the open menu, with a Claude CLI agent, an API agent and a leftover Codex CLI agent listed', async () => {
    render(AgentSelector, { props: { data: {} } })
    const trigger = screen.getByTestId('agent-selector')
    expect(trigger.textContent).toContain('Bram')
    expectNoTypeBadge(trigger)
    expect(trigger.textContent).not.toMatch(/codex/i)
    expect(trigger.getAttribute('aria-label') ?? '').not.toMatch(/codex/i)

    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = await waitFor(() => {
      const content = document.querySelector('.agent-selector-dropdown') as HTMLElement | null
      expect(content).not.toBeNull()
      return content!
    })
    const claudeItem = within(menu).getByRole('menuitem', { name: 'Switch chat target to Bram' })
    const apiItem = within(menu).getByRole('menuitem', { name: 'Switch chat target to Sol' })
    expectNoTypeBadge(claudeItem)
    expectNoTypeBadge(apiItem)
    // The leftover lists like any agent: its name, nothing more.
    const leftoverItem = within(menu).getByRole('menuitem', { name: 'Switch chat target to Rook' })
    expectNoTypeBadge(leftoverItem)
    expectNoCodexMarker(leftoverItem)
    expectNoTypeBadge(menu)
    expect(menu.textContent).not.toMatch(/codex/i)
    for (const element of menu.querySelectorAll('[aria-label], [title]')) {
      expect(`${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`).not.toMatch(/codex/i)
    }
  })

  it('with the leftover Codex CLI agent as the selected target', async () => {
    agentStore.setCurrentAgentId(LEFTOVER_CODEX_CLI_AGENT.id)
    render(AgentSelector, { props: { data: {} } })
    const trigger = screen.getByTestId('agent-selector')
    expect(trigger.textContent).toContain('Rook')
    expectNoTypeBadge(trigger)
    expectNoCodexMarker(trigger)

    const menu = await openMenu(trigger)
    for (const name of ['Bram', 'Sol', 'Rook']) {
      expect(within(menu).getByRole('menuitem', { name: `Switch chat target to ${name}` })).toBeTruthy()
    }
    expectNoCodexMarker(menu)
  })
})
