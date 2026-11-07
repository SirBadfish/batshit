import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { installAgentRoutes, loadAgentRoute } from '$lib/test-utils/agentPutRoute'
import * as agents from '$lib/stores/agents.svelte'
import { setSavedModels } from '$lib/stores/savedModels.svelte'
import { getAgentReasoningSave, waitForAgentReasoningSaves } from '$lib/stores/agentReasoningSaves.svelte'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
import type { SavedModel } from '$lib/types/savedModels'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
import type { LocalReasoningContract } from '$lib/types/reasoningControls'

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({ deleteManagedProfileFolder: vi.fn(async () => {}) }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: vi.fn(async () => {}), deleteAgentClaudeConfig: vi.fn(async () => {}), agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`]) }))
useRedisTestServer()
let Component: typeof import('./ModelReasoningControl.svelte').default
// Cold Svelte/primitive transformation exceeded the default hook at one worker too.
// Use the documented component-fixture import budget; interaction deadlines stay unchanged.
beforeAll(async () => { Component = (await import('./ModelReasoningControl.svelte')).default }, 60_000)
afterEach(() => { cleanup(); vi.unstubAllGlobals(); agents.setAgents([]); agents.setCurrentAgentId(null); setSavedModels([]) })
const preset = { id: 'reasoning-shared', modelId: 'gpt-6.1-sol', effectiveModelId: 'gpt-6.1-sol', provider: 'openai', modelName: 'Sol',
  connection: { type: 'direct', id: 'direct:openai', service: 'openai' }, pricing: {}, createdAt: '', updatedAt: '',
  settings: { 'openai.reasoningEffort': 'high', temperature: 0 } } satisfies SavedModel
const key = reasoningOverrideKey({ presetId: preset.id, connection: preset.connection, effectiveModelId: preset.modelId }, 'effort')
const localPreset = { ...preset, id: 'local-shared', provider: 'qwen', modelId: 'catalog/qwen-local', effectiveModelId: 'qwen3.5:9b-q4_K_M',
  connection: { type: 'direct' as const, id: 'direct:ollama', service: 'ollama' }, capabilities: { reasoning: false }, settings: {} } satisfies SavedModel
function localContract(modelId = localPreset.effectiveModelId): LocalReasoningContract {
  return { version: 1, status: 'verified', connectionId: 'direct:ollama', effectiveModelId: modelId, adapterVersion: '4.0.1',
    runtimeVersion: '0.40.3', checkedAt: '2026-10-15T00:00:00Z', thinking: { values: [false, true], default: true } }
}

async function open(id: string, value?: string) {
  const agent: any = { id, user_id: 'reasoning-user', displayName: id, agentType: 'api', created_at: '', updated_at: '',
    primary_model_preset_id: preset.id, primary_model_name: preset.modelId, primary_model_connection: preset.connection,
    provider_specific_settings: { 'openai.reasoningEffort': 'high', temperature: 0 },
    ...(value ? { model_reasoning_overrides: { [key]: { mode: 'value' as const, value } } } : {}) }
  await redis.createAgent(agent as any)
  agents.setAgents([agent]); agents.setCurrentAgentId(id); setSavedModels([preset])
  const route = await loadAgentRoute()
  const network = installAgentRoutes({ agentId: id, userId: agent.user_id, route })
  return { agent, network }
}

describe('SA-132 one mounted reasoning choice in chat and Agent Settings', () => {
  it('checks selected local metadata and shares one acknowledged Thinking leaf without changing the blank preset', async () => {
    const { agent } = await open('reasoning_local_toggle')
    await redis.updateAgent(agent.id, { primary_model_preset_id: localPreset.id, primary_model_connection: localPreset.connection } as any)
    agents.updateAgent(agent.id, { primary_model_preset_id: localPreset.id, primary_model_connection: localPreset.connection } as any)
    setSavedModels([localPreset])
    const toggleKey = reasoningOverrideKey({ presetId: localPreset.id, connection: localPreset.connection, effectiveModelId: localPreset.effectiveModelId }, 'thinking')
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const network = installAgentRoutes({ agentId: agent.id, userId: agent.user_id, route: await loadAgentRoute(), holdPuts: () => held,
      extra: path => path === '/api/settings/local-ai/models' ? Response.json({ reasoning: { key: toggleKey, contract: localContract() } }) : undefined })
    const chat = render(Component)
    const settings = render(Component, { agentId: agent.id, preset: localPreset, surface: 'settings' })
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking' }))
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'On', exact: true })).toBeTruthy())
    expect(within(screen.getByRole('menu')).getByText('Preset thinking: Default (Off)')).toBeTruthy()
    expect(within(screen.getByRole('menu')).getByText('Use the provider’s default (On)')).toBeTruthy()
    expect(network.puts).toHaveLength(0)
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'On', exact: true }))
    await waitFor(() => expect(network.puts).toHaveLength(1))
    await expect(waitForAgentReasoningSaves(agent.id, 1)).rejects.toThrow(/still saving/)
    release()
    await waitFor(() => expect(getAgentReasoningSave(agent.id, toggleKey)).toBeUndefined())
    expect(within(settings.container).getByRole('button', { name: 'Thinking' }).textContent?.trim()).toBe('On')
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking' }))
    await fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Provider default/ }))
    await waitFor(() => expect(agents.getAgentById(agent.id)?.model_reasoning_overrides?.[toggleKey]).toEqual({ mode: 'provider-default' }))
    expect(within(settings.container).getByRole('button', { name: 'Thinking' }).textContent).toContain('Provider default')
    expect(network.puts.map(put => put.body.model_reasoning_overrides)).toEqual([
      { [toggleKey]: { mode: 'value', value: true } }, { [toggleKey]: { mode: 'provider-default' } }
    ])
    expect(localPreset.settings).toEqual({})
    expect(localPreset.capabilities.reasoning).toBe(false)
  })

  it('discards a late local read after a model switch and invalidates choices when the connection changes', async () => {
    const { agent } = await open('reasoning_local_late')
    agents.updateAgent(agent.id, { primary_model_preset_id: localPreset.id, primary_model_connection: localPreset.connection } as any)
    const second = { ...localPreset, id: 'local-second', effectiveModelId: 'another-exact-tag' }
    setSavedModels([localPreset, second])
    let release!: (response: Response) => void
    const first = new Promise<Response>(resolve => { release = resolve })
    let current: LocalReasoningContract = localContract(second.effectiveModelId)
    const nextKey = reasoningOverrideKey({ presetId: second.id, connection: second.connection, effectiveModelId: second.effectiveModelId }, 'thinking')
    const http = vi.fn().mockImplementationOnce(() => first).mockImplementation(async () => Response.json({ reasoning: { key: nextKey, contract: current } }))
    vi.stubGlobal('fetch', http)
    const chat = render(Component)
    await waitFor(() => expect(http).toHaveBeenCalledTimes(1))
    agents.updateAgent(agent.id, { primary_model_preset_id: second.id } as any)
    await waitFor(() => expect(http).toHaveBeenCalledTimes(2))
    release(Response.json({ reasoning: { key: reasoningOverrideKey({ presetId: localPreset.id, connection: localPreset.connection, effectiveModelId: localPreset.effectiveModelId }, 'thinking'), contract: localContract() } }))
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking' }))
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'On', exact: true })).toBeTruthy())
    current = { ...localContract(second.effectiveModelId), status: 'unverified', thinking: undefined }
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated))
    await waitFor(() => expect(screen.queryByRole('menuitemradio', { name: 'On', exact: true })).toBeNull())
    expect(await screen.findByText('Thinking options are not verified for this model and Ollama version.')).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /^Use preset/ })).toBeTruthy()
    expect(http.mock.calls.every(call => String(call[0]).includes(`agentId=${agent.id}`))).toBe(true)
  })

  it('hydrates without saving; a chat pick updates Settings and only its own saved leaf', async () => {
    const { agent, network } = await open('reasoning_mounted')
    const chat = render(Component)
    const settings = render(Component, { agentId: agent.id, preset, surface: 'settings' })
    expect(network.puts).toHaveLength(0)
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Reasoning effort' }))
    expect(within(screen.getByRole('menu')).getByText('Preset effort: high')).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /^None/ })).toBeNull()
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /^Max/ }))
    await waitFor(() => expect(within(settings.container).getByRole('button', { name: 'Reasoning effort' }).textContent).toContain('Max'))
    await waitFor(() => expect(getAgentReasoningSave(agent.id, key)).toBeUndefined())
    expect(network.puts.map(put => put.body)).toEqual([{ model_reasoning_overrides: { [key]: { mode: 'value', value: 'max' } } }])
    expect((await redis.get(`agent:${agent.id}`)).provider_specific_settings).toEqual(agent.provider_specific_settings)
    expect(preset.settings).toEqual({ 'openai.reasoningEffort': 'high', temperature: 0 })
    // A later authoritative read must replace the settled display, not lose to a sticky overlay.
    agents.updateAgent(agent.id, { model_reasoning_overrides: { [key]: { mode: 'value', value: 'low' } } })
    await waitFor(() => expect(within(settings.container).getByRole('button', { name: 'Reasoning effort' }).textContent).toContain('Low'))
    expect(within(chat.container).getByRole('button', { name: 'Reasoning effort' }).textContent).toContain('Low')
  })

  it('shares effort and mode while offering only final compatible pairs and retaining a raced invalid pair', async () => {
    const { agent } = await open('reasoning_pair')
    const claude = { ...preset, id: 'claude-pair', provider: 'anthropic', modelId: 'claude-sonnet-5-5', effectiveModelId: 'claude-sonnet-5-5',
      connection: { type: 'direct' as const, id: 'direct:anthropic', service: 'anthropic' }, settings: { thinkingMode: 'between_tools', anthropicEffort: 'high' } }
    const identity = { presetId: claude.id, connection: claude.connection, effectiveModelId: claude.modelId }
    const effort = reasoningOverrideKey(identity, 'effort'), mode = reasoningOverrideKey(identity, 'mode')
    await redis.updateAgent(agent.id, { primary_model_preset_id: claude.id, primary_model_connection: claude.connection } as any)
    agents.updateAgent(agent.id, { primary_model_preset_id: claude.id, primary_model_connection: claude.connection } as any)
    setSavedModels([claude])
    const network = installAgentRoutes({ agentId: agent.id, userId: agent.user_id, route: await loadAgentRoute() })
    const chat = render(Component)
    const settings = render(Component, { agentId: agent.id, preset: claude, surface: 'settings' })
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Reasoning controls' }))
    expect(screen.queryByRole('menuitemradio', { name: /^Max/ })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: /^Extra High/ })).toBeNull()
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /^Adaptive/ }))
    await waitFor(() => expect(getAgentReasoningSave(agent.id, mode)).toBeUndefined())
    expect(within(settings.container).getByRole('button', { name: 'Thinking mode' }).textContent).toContain('Adaptive')
    await fireEvent.keyDown(within(settings.container).getByRole('button', { name: 'Reasoning effort' }), { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getAllByRole('listbox')).toHaveLength(1))
    await fireEvent.pointerUp(screen.getByRole('option', { name: 'Max', exact: true }), { pointerType: 'mouse' })
    await waitFor(() => expect(network.puts).toHaveLength(2))
    await waitFor(() => expect(getAgentReasoningSave(agent.id, effort)).toBeUndefined())
    expect(network.puts.map(put => Object.keys(put.body.model_reasoning_overrides))).toEqual([[mode], [effort]])
    expect(claude.settings).toEqual({ thinkingMode: 'between_tools', anthropicEffort: 'high' })
    // An external racing writer can leave an invalid pair. It stays visible and the shared Send validator refuses it.
    agents.updateAgent(agent.id, { model_reasoning_overrides: { [mode]: { mode: 'value', value: 'between_tools' }, [effort]: { mode: 'value', value: 'max' } } })
    await waitFor(() => expect(within(settings.container).getByRole('button', { name: 'Reasoning effort' }).textContent).toContain('Saved: max (unavailable)'))
    expect(within(settings.container).getByText(/cannot use max effort/)).toBeTruthy()
  })

  it('saves MiMo Off as false and shares it with Settings without touching legacy custom effort', async () => {
    const { agent } = await open('reasoning_mimo_toggle')
    const mimo = { ...preset, id: 'mimo-toggle', provider: 'xiaomi', modelId: 'mimo-v2.5-pro', effectiveModelId: 'mimo-v2.5-pro',
      connection: { type: 'direct' as const, id: 'direct:mimo', service: 'mimo' }, settings: { mimoThinking: true, 'openai.reasoningEffort': 'high' } }
    const toggleKey = reasoningOverrideKey({ presetId: mimo.id, connection: mimo.connection, effectiveModelId: mimo.modelId }, 'thinking')
    await redis.updateAgent(agent.id, { primary_model_preset_id: mimo.id, primary_model_connection: mimo.connection } as any)
    agents.updateAgent(agent.id, { primary_model_preset_id: mimo.id, primary_model_connection: mimo.connection } as any)
    setSavedModels([mimo])
    const network = installAgentRoutes({ agentId: agent.id, userId: agent.user_id, route: await loadAgentRoute() })
    const chat = render(Component)
    const settings = render(Component, { agentId: agent.id, preset: mimo, surface: 'settings' })
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking' }))
    expect(within(screen.getByRole('menu')).getByText('Preset thinking: On')).toBeTruthy()
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Off', exact: true }))
    await waitFor(() => expect(network.puts).toHaveLength(1))
    await waitFor(() => expect(getAgentReasoningSave(agent.id, toggleKey)).toBeUndefined())
    expect(network.puts[0].body).toEqual({ model_reasoning_overrides: { [toggleKey]: { mode: 'value', value: false } } })
    expect(within(settings.container).getByRole('button', { name: 'Thinking' }).textContent?.trim()).toBe('Off')
    expect(mimo.settings).toEqual({ mimoThinking: true, 'openai.reasoningEffort': 'high' })
  })

  it('keeps an invalid requested budget modal until Cancel or an acknowledged one-leaf Save', async () => {
    const { agent } = await open('reasoning_budget_modal')
    const google = { ...preset, id: 'budget-modal', provider: 'google', modelId: 'gemini-2.5-pro', effectiveModelId: 'gemini-2.5-pro',
      connection: { type: 'direct' as const, id: 'direct:google', service: 'google' }, settings: { thinkingBudget: 2048 } }
    const budgetKey = reasoningOverrideKey({ presetId: google.id, connection: google.connection, effectiveModelId: google.modelId }, 'budget')
    await redis.updateAgent(agent.id, { primary_model_preset_id: google.id, primary_model_connection: google.connection } as any)
    agents.updateAgent(agent.id, { primary_model_preset_id: google.id, primary_model_connection: google.connection } as any)
    setSavedModels([google])
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const network = installAgentRoutes({ agentId: agent.id, userId: agent.user_id, route: await loadAgentRoute(), holdPuts: () => held })
    const chat = render(Component)
    const settings = render(Component, { agentId: agent.id, preset: google, surface: 'settings' })
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking budget' }))
    expect(screen.queryByRole('menuitemradio', { name: 'Off', exact: true })).toBeNull()
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Set token budget…', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: 'Set thinking budget' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const input = within(dialog).getByRole('textbox', { name: 'Requested token budget' })
    await fireEvent.input(input, { target: { value: '1.5' } })
    await fireEvent.submit(input.closest('form')!)
    expect(within(dialog).getByRole('alert').textContent).toContain('whole requested token budget')
    expect((input as HTMLInputElement).value).toBe('1.5')
    expect(network.puts).toHaveLength(0)
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel', exact: true }))
    expect(network.puts).toHaveLength(0)
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking budget' }))
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Set token budget…', exact: true }))
    const reopened = await screen.findByRole('dialog', { name: 'Set thinking budget' })
    const valid = within(reopened).getByRole('textbox', { name: 'Requested token budget' })
    await fireEvent.input(valid, { target: { value: '512' } })
    await fireEvent.submit(valid.closest('form')!)
    await waitFor(() => expect(network.puts).toHaveLength(1))
    await expect(waitForAgentReasoningSaves(agent.id, 1)).rejects.toThrow(/still saving/)
    expect((valid as HTMLInputElement).disabled).toBe(true)
    release()
    await waitFor(() => expect(getAgentReasoningSave(agent.id, budgetKey)).toBeUndefined())
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set thinking budget' })).toBeNull())
    expect(network.puts[0].body).toEqual({ model_reasoning_overrides: { [budgetKey]: { mode: 'value', value: 512 } } })
    expect(within(settings.container).getByRole('button', { name: 'Thinking budget' }).textContent).toContain('512 tokens')
    expect(google.settings).toEqual({ thinkingBudget: 2048 })
  })

  it('keeps Off zero, Dynamic minus-one, provider default and inheritance distinct in mirrored budget fields', async () => {
    const { agent } = await open('reasoning_budget_specials')
    const google = { ...preset, id: 'budget-specials', provider: 'google', modelId: 'gemini-2.5-flash-lite', effectiveModelId: 'gemini-2.5-flash-lite',
      connection: { type: 'direct' as const, id: 'direct:google', service: 'google' }, settings: {} }
    const budgetKey = reasoningOverrideKey({ presetId: google.id, connection: google.connection, effectiveModelId: google.modelId }, 'budget')
    await redis.updateAgent(agent.id, { primary_model_preset_id: google.id, primary_model_connection: google.connection } as any)
    agents.updateAgent(agent.id, { primary_model_preset_id: google.id, primary_model_connection: google.connection } as any)
    setSavedModels([google])
    const network = installAgentRoutes({ agentId: agent.id, userId: agent.user_id, route: await loadAgentRoute() })
    const chat = render(Component)
    const settings = render(Component, { agentId: agent.id, preset: google, surface: 'settings' })
    expect(network.puts).toHaveLength(0)
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking budget' }))
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Off', exact: true }))
    await waitFor(() => expect(agents.getAgentById(agent.id)?.model_reasoning_overrides?.[budgetKey]).toEqual({ mode: 'value', value: 0 }))
    await fireEvent.keyDown(within(settings.container).getByRole('button', { name: 'Thinking budget' }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Dynamic', exact: true }), { pointerType: 'mouse' })
    await waitFor(() => expect(agents.getAgentById(agent.id)?.model_reasoning_overrides?.[budgetKey]).toEqual({ mode: 'value', value: -1 }))
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking budget' }))
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /^Provider default/ }))
    await waitFor(() => expect(agents.getAgentById(agent.id)?.model_reasoning_overrides?.[budgetKey]).toEqual({ mode: 'provider-default' }))
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Thinking budget' }))
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /^Use preset/ }))
    await waitFor(() => expect(agents.getAgentById(agent.id)?.model_reasoning_overrides?.[budgetKey]).toBeUndefined())
    expect(network.puts.map(put => put.body.model_reasoning_overrides[budgetKey])).toEqual([
      { mode: 'value', value: 0 }, { mode: 'value', value: -1 }, { mode: 'provider-default' }, null
    ])
    expect(google.settings).toEqual({})
  })

  it('shows invalid saved intent without clamping or a hydration write', async () => {
    const { network } = await open('reasoning_invalid', 'none')
    const chat = render(Component)
    expect(chat.getByRole('button', { name: 'Reasoning effort' }).textContent).toContain('Unavailable')
    expect(network.puts).toHaveLength(0)
    await fireEvent.click(chat.getByRole('button', { name: 'Reasoning effort' }))
    expect(screen.getByText('Saved choice: none (unavailable). Choose another setting.')).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /^None/ })).toBeNull()
  })

  it('a portalled option cannot target a newly selected agent or bypass a newly locked owner', async () => {
    const { agent, network } = await open('reasoning_owner')
    let editable = true
    const chat = render(Component, { canEdit: () => editable })
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Reasoning effort' }))
    const staleOption = screen.getByRole('menuitemradio', { name: /^Max/ })
    editable = false
    await fireEvent.click(staleOption)
    expect(network.puts).toHaveLength(0)
    editable = true
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Reasoning effort' }))
    const beforeSwitch = screen.getByRole('menuitemradio', { name: /^Max/ })
    agents.addAgent({ ...agent, id: 'reasoning_new_owner' })
    agents.setCurrentAgentId('reasoning_new_owner')
    await fireEvent.click(beforeSwitch)
    expect(network.puts).toHaveLength(0)
  })
})

describe('SA-139 Claude plan reasoning choices', () => {
  const plan = (modelId: string) => ({ ...preset, id: `plan-${modelId}`, provider: 'anthropic', modelId, effectiveModelId: modelId, modelName: `Plan ${modelId}`,
    connection: { type: 'direct' as const, id: 'claude-plan:local', service: 'claude-plan' }, settings: { anthropicEffort: 'high' } })
  async function openPlan(id: string, model: ReturnType<typeof plan>) {
    const { agent } = await open(id)
    const fields = { primary_model_preset_id: model.id, primary_model_name: model.modelId, primary_model_provider: 'anthropic', primary_model_connection: model.connection,
      provider_specific_settings: { anthropicEffort: 'high' } }
    await redis.updateAgent(agent.id, fields as any)
    agents.updateAgent(agent.id, fields as any)
    setSavedModels([model])
    const network = installAgentRoutes({ agentId: agent.id, userId: agent.user_id, route: await loadAgentRoute() })
    return { agent, network }
  }

  it('offers only Claude Code effort on a model whose thinking cannot be turned off, and saves the plan setting key', async () => {
    const model = plan('claude-opus-5-5')
    const { agent, network } = await openPlan('reasoning_plan_effort', model)
    const chat = render(Component)
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Reasoning effort' }))
    expect(within(screen.getByRole('menu')).getByText('Preset effort: high')).toBeTruthy()
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent?.trim().split('\n')[0])).toEqual(
      expect.arrayContaining(['Low', 'Medium', 'High', 'Extra High', 'Max']))
    expect(screen.queryByText(/Thinking mode|token budget|Between tools/i)).toBeNull()
    expect(within(chat.container).queryByRole('button', { name: 'Thinking' })).toBeNull()
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /^Extra High/ }))
    const effortKey = reasoningOverrideKey({ presetId: model.id, connection: model.connection, effectiveModelId: model.modelId }, 'effort')
    await waitFor(() => expect(network.puts.map(put => put.body)).toEqual([{ model_reasoning_overrides: { [effortKey]: { mode: 'value', value: 'xhigh' } } }]))
    const { resolveRuntimeModelSelection } = await import('$lib/utils/modelPresetRuntime')
    const selection = resolveRuntimeModelSelection({ preset: model as any, agent: agents.getAgentById(agent.id) as any, transport: 'api',
      reasoningOverrides: agents.getAgentById(agent.id)?.model_reasoning_overrides } as any)
    expect(selection.settings).toMatchObject({ anthropicEffort: 'xhigh' })
  })

  it('shows the Send refusal in the menu for a plan preset that holds a setting Claude Code cannot take', async () => {
    const model = { ...plan('claude-opus-5-5'), settings: { anthropicEffort: 'high', temperature: 0.5 } }
    await openPlan('reasoning_plan_refused', model)
    const chat = render(Component)
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Reasoning effort' }))
    expect(await within(screen.getByRole('menu')).findByText(/The Claude plan connection does not support temperature/)).toBeTruthy()
  })

  it('adds Thinking only where Claude Code can turn it off', async () => {
    const model = plan('claude-opus-4-6')
    const { network } = await openPlan('reasoning_plan_thinking', model)
    const chat = render(Component)
    await fireEvent.click(within(chat.container).getByRole('button', { name: 'Reasoning controls' }))
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Off', exact: true })).toBeTruthy())
    expect(screen.queryByText(/token budget|Between tools/i)).toBeNull()
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Off', exact: true }))
    const thinkingKey = reasoningOverrideKey({ presetId: model.id, connection: model.connection, effectiveModelId: model.modelId }, 'thinking')
    await waitFor(() => expect(network.puts.map(put => put.body)).toEqual([{ model_reasoning_overrides: { [thinkingKey]: { mode: 'value', value: false } } }]))
  })
})
