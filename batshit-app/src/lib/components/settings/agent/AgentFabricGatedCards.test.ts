import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import AgentDmsSettingsCard from './AgentDmsSettingsCard.svelte'
import AgentJevJuiceSettingsCard from './AgentJevJuiceSettingsCard.svelte'

/**
 * Josh, 2026-10-24: Agent DMs and the Judge Juice Judgment Tool are Fabric controls, so their
 * switches cannot be changed while the agent's Fabric & Utilities switch is off. The saved
 * choice still shows, and a short note says why.
 */
const noop = () => {}

function dmsProps(fabricUtilitiesEnabled: boolean) {
  return {
    dmsEnabled: true,
    dmSenderScope: 'selected' as const,
    dmSenderAgentIds: [],
    senderCandidates: [{ id: 'agent-faye', name: 'Faye', dmsEnabled: true }],
    wakeEnabled: true,
    wakeTimeoutMinutes: null,
    wakeTarget: 'new-session' as const,
    fabricUtilitiesEnabled,
    onDmsEnabledChange: noop,
    onDmSenderScopeChange: noop,
    onDmSenderAgentIdsChange: noop,
    onWakeEnabledChange: noop,
    onWakeTimeoutMinutesChange: noop,
    onWakeTargetChange: noop
  }
}

function judgeProps(fabricUtilitiesEnabled: boolean) {
  return {
    skillSessionMode: 'off' as const,
    judgeToolEnabled: true,
    memoryRerankEnabled: false,
    memoryRecallEnabled: false,
    replyCheckEnabled: false,
    styleCoachEnabled: false,
    memoryEnabled: true,
    fabricUtilitiesEnabled,
    onSkillSessionModeChange: noop,
    onJudgeToolEnabledChange: noop,
    onMemoryRerankEnabledChange: noop,
    onMemoryRecallEnabledChange: noop,
    onReplyCheckEnabledChange: noop,
    onStyleCoachEnabledChange: noop
  }
}

function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute('disabled') || element.hasAttribute('data-disabled')
}

describe('Agent DMs and the Judgment Tool need Fabric & Utilities', () => {
  it('shows Suggest without firing a change and requires an explicit selection to manage sessions', async () => {
    const onSkillSessionModeChange = vi.fn()
    render(AgentJevJuiceSettingsCard, { props: {
      ...judgeProps(true), skillSessionMode: 'suggest', onSkillSessionModeChange
    } })
    const select = screen.getByTestId('agent-jev-skill-tool-hints-select')
    expect(select.textContent?.trim()).toBe('Suggest')
    expect(onSkillSessionModeChange).not.toHaveBeenCalled()
    await fireEvent.keyDown(select, { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Help manage skill sessions', exact: true }), { pointerType: 'mouse' })
    expect(onSkillSessionModeChange.mock.calls).toEqual([['manage']])
  })
  it('locks the Agent DMs switch and its sender list, keeps the saved choice, and says why', () => {
    const { getByTestId } = render(AgentDmsSettingsCard, { props: dmsProps(false) })
    const toggle = getByTestId('agent-dms-enabled-toggle')
    expect(isDisabled(toggle)).toBe(true)
    expect(toggle.getAttribute('data-state')).toBe('checked')
    expect(isDisabled(getByTestId('agent-dm-sender-agent-faye'))).toBe(true)
    expect(getByTestId('agent-dms-needs-fabric').textContent).toContain(
      'Needs Fabric & Utilities, which is off for this agent. Your choice is kept'
    )
    // May Be Woken is its own switch and stays free.
    expect(isDisabled(getByTestId('agent-wake-enabled-toggle'))).toBe(false)
  })

  it('leaves Agent DMs alone while Fabric & Utilities is on', () => {
    const { getByTestId, queryByTestId } = render(AgentDmsSettingsCard, { props: dmsProps(true) })
    expect(isDisabled(getByTestId('agent-dms-enabled-toggle'))).toBe(false)
    expect(queryByTestId('agent-dms-needs-fabric')).toBeNull()
  })

  it('locks only the Judgment Tool switch, keeps the saved choice, and says why', () => {
    const { getByTestId } = render(AgentJevJuiceSettingsCard, { props: judgeProps(false) })
    const toggle = getByTestId('agent-jev-judge-tool-toggle')
    expect(isDisabled(toggle)).toBe(true)
    expect(toggle.getAttribute('data-state')).toBe('checked')
    expect(getByTestId('agent-jev-judge-tool-needs-fabric').textContent).toContain(
      'Needs Fabric & Utilities'
    )
    // The other Judge Juice switches are not Fabric controls.
    expect(isDisabled(getByTestId('agent-jev-memory-rerank-toggle'))).toBe(false)
  })

  it('leaves the Judgment Tool alone while Fabric & Utilities is on', () => {
    const { getByTestId, queryByTestId } = render(AgentJevJuiceSettingsCard, { props: judgeProps(true) })
    expect(isDisabled(getByTestId('agent-jev-judge-tool-toggle'))).toBe(false)
    expect(queryByTestId('agent-jev-judge-tool-needs-fabric')).toBeNull()
  })
})
