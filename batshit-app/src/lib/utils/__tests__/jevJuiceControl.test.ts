import { describe, expect, it } from 'vitest'
import {
  AGENT_JEV_JUDGE_TOOL_FIELD,
  AGENT_JEV_MEMORY_RECALL_FIELD,
  AGENT_JEV_MEMORY_RERANK_FIELD,
  AGENT_JEV_REPLY_CHECK_FIELD,
  AGENT_JEV_SKILL_TOOL_HINTS_FIELD,
  AGENT_JEV_STYLE_COACH_FIELD,
  resolveAgentJevJudgeToolEnabled,
  resolveAgentJevMemoryRecallEnabled,
  resolveAgentJevMemoryRerankEnabled,
  resolveAgentJevReplyCheckEnabled,
  resolveAgentJevSkillToolHintsEnabled,
  resolveAgentJevStyleCoachEnabled,
  GLOBAL_JEV_SMART_ZIP_FIELD,
  GLOBAL_JEV_SMART_ZIP_LABEL,
  JEV_INCOMING_TEXT_SCREEN_FIELD,
  JEV_INCOMING_TEXT_SCREEN_LABEL,
  resolveJevIncomingTextScreenEnabled,
  resolveJevSmartZipEnabled,
  validateJevJuiceAgentFields,
  validateJevJuiceGlobalZipFields
} from '../jevJuiceControl'
import { TYPESAFE_FEATURES } from '../jevJuice'

/** SA-120 P1 — the per-agent switch: absent means OFF; only literal `true` is ON. */
describe('resolveAgentJevSkillToolHintsEnabled', () => {
  it('reads absent, null, false, and truthy non-booleans as OFF', () => {
    expect(resolveAgentJevSkillToolHintsEnabled(null)).toBe(false)
    expect(resolveAgentJevSkillToolHintsEnabled({})).toBe(false)
    expect(resolveAgentJevSkillToolHintsEnabled({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: null })).toBe(false)
    expect(resolveAgentJevSkillToolHintsEnabled({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: false })).toBe(false)
    expect(resolveAgentJevSkillToolHintsEnabled({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: 'true' })).toBe(false)
    expect(resolveAgentJevSkillToolHintsEnabled({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: 1 })).toBe(false)
  })

  it('reads literal true as ON', () => {
    expect(resolveAgentJevSkillToolHintsEnabled({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: true })).toBe(true)
  })
})

describe('validateJevJuiceAgentFields', () => {
  it('accepts absent, null, and booleans', () => {
    expect(validateJevJuiceAgentFields({})).toBeNull()
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: null })).toBeNull()
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: true })).toBeNull()
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: false })).toBeNull()
  })

  it('refuses anything else loudly, naming the switch', () => {
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: 'yes' })).toMatch(/Suggest Skills and Tools.*true or false/)
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: 1 })).toMatch(/true or false/)
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_JUDGE_TOOL_FIELD]: 'on' })).toMatch(/Judgment Tool.*true or false/)
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_MEMORY_RERANK_FIELD]: 'on' })).toMatch(/Rerank Memory Search.*true or false/)
  })
})

describe('resolveAgentJevJudgeToolEnabled (SA-120 P2)', () => {
  it('is OFF unless the record holds literal true', () => {
    expect(resolveAgentJevJudgeToolEnabled(null)).toBe(false)
    expect(resolveAgentJevJudgeToolEnabled({})).toBe(false)
    expect(resolveAgentJevJudgeToolEnabled({ [AGENT_JEV_JUDGE_TOOL_FIELD]: 'true' })).toBe(false)
    expect(resolveAgentJevJudgeToolEnabled({ [AGENT_JEV_JUDGE_TOOL_FIELD]: true })).toBe(true)
    // The two switches are independent.
    expect(resolveAgentJevSkillToolHintsEnabled({ [AGENT_JEV_JUDGE_TOOL_FIELD]: true })).toBe(false)
  })
})

describe('resolveAgentJevMemoryRerankEnabled (SA-120 P4a)', () => {
  it('is OFF unless the record holds literal true, and stands apart from the other switches', () => {
    expect(resolveAgentJevMemoryRerankEnabled(null)).toBe(false)
    expect(resolveAgentJevMemoryRerankEnabled({})).toBe(false)
    expect(resolveAgentJevMemoryRerankEnabled({ [AGENT_JEV_MEMORY_RERANK_FIELD]: 'true' })).toBe(false)
    expect(resolveAgentJevMemoryRerankEnabled({ [AGENT_JEV_MEMORY_RERANK_FIELD]: true })).toBe(true)
    expect(resolveAgentJevMemoryRerankEnabled({ [AGENT_JEV_JUDGE_TOOL_FIELD]: true, memory_enabled: true })).toBe(false)
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_MEMORY_RERANK_FIELD]: true })).toBeNull()
  })
})

describe('resolveAgentJevMemoryRecallEnabled (SA-120 P4b)', () => {
  it('is OFF unless the record holds literal true, and stands apart from the rerank switch', () => {
    expect(resolveAgentJevMemoryRecallEnabled(null)).toBe(false)
    expect(resolveAgentJevMemoryRecallEnabled({})).toBe(false)
    expect(resolveAgentJevMemoryRecallEnabled({ [AGENT_JEV_MEMORY_RECALL_FIELD]: 1 })).toBe(false)
    expect(resolveAgentJevMemoryRecallEnabled({ [AGENT_JEV_MEMORY_RECALL_FIELD]: true })).toBe(true)
    expect(resolveAgentJevMemoryRecallEnabled({ [AGENT_JEV_MEMORY_RERANK_FIELD]: true })).toBe(false)
    expect(resolveAgentJevMemoryRerankEnabled({ [AGENT_JEV_MEMORY_RECALL_FIELD]: true })).toBe(false)
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_MEMORY_RECALL_FIELD]: 'on' })).toMatch(/Recall by Meaning.*true or false/)
  })
})

describe('the two after-reply switches (SA-120 P6)', () => {
  it('are each OFF unless the record holds literal true, and stand apart from each other and from every other switch', () => {
    for (const [resolve, field] of [
      [resolveAgentJevReplyCheckEnabled, AGENT_JEV_REPLY_CHECK_FIELD],
      [resolveAgentJevStyleCoachEnabled, AGENT_JEV_STYLE_COACH_FIELD]
    ] as const) {
      expect(resolve(null)).toBe(false)
      expect(resolve({})).toBe(false)
      expect(resolve({ [field]: null })).toBe(false)
      expect(resolve({ [field]: false })).toBe(false)
      expect(resolve({ [field]: 'true' })).toBe(false)
      expect(resolve({ [field]: 1 })).toBe(false)
      expect(resolve({ [field]: true })).toBe(true)
    }
    expect(resolveAgentJevReplyCheckEnabled({ [AGENT_JEV_STYLE_COACH_FIELD]: true })).toBe(false)
    expect(resolveAgentJevStyleCoachEnabled({ [AGENT_JEV_REPLY_CHECK_FIELD]: true })).toBe(false)
    expect(resolveAgentJevReplyCheckEnabled({ [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: true, [AGENT_JEV_JUDGE_TOOL_FIELD]: true })).toBe(false)
  })

  it('are refused loudly on write when they are not booleans, and their labels follow the naming rule', () => {
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_REPLY_CHECK_FIELD]: true, [AGENT_JEV_STYLE_COACH_FIELD]: null })).toBeNull()
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_REPLY_CHECK_FIELD]: 'on' })).toMatch(/Jev Juice: Check Replies.*true or false/)
    expect(validateJevJuiceAgentFields({ [AGENT_JEV_STYLE_COACH_FIELD]: 1 })).toMatch(/Jev Juice: Style Coach.*true or false/)
    expect(TYPESAFE_FEATURES.reply_check.switchLabel).toBe('Jev Juice: Check Replies')
    expect(TYPESAFE_FEATURES.style_coach.switchLabel).toBe('Jev Juice: Style Coach')
  })
})

describe('resolveJevSmartZipEnabled (SA-120 P5, the ONE global switch)', () => {
  it('is OFF unless the global zip settings hold literal true', () => {
    expect(resolveJevSmartZipEnabled(null)).toBe(false)
    expect(resolveJevSmartZipEnabled(undefined)).toBe(false)
    expect(resolveJevSmartZipEnabled({})).toBe(false)
    expect(resolveJevSmartZipEnabled({ zip_tool_notes_enabled: true })).toBe(false)
    expect(resolveJevSmartZipEnabled({ [GLOBAL_JEV_SMART_ZIP_FIELD]: false })).toBe(false)
    expect(resolveJevSmartZipEnabled({ [GLOBAL_JEV_SMART_ZIP_FIELD]: 'true' })).toBe(false)
    expect(resolveJevSmartZipEnabled({ [GLOBAL_JEV_SMART_ZIP_FIELD]: 1 })).toBe(false)
    expect(resolveJevSmartZipEnabled({ [GLOBAL_JEV_SMART_ZIP_FIELD]: true })).toBe(true)
  })

  it('is global on purpose: an agent record carrying the field turns nothing on', () => {
    // The send path hands this rule `global_zip_settings`, never the agent.
    expect(resolveAgentJevSkillToolHintsEnabled({ [GLOBAL_JEV_SMART_ZIP_FIELD]: true })).toBe(false)
    expect(validateJevJuiceAgentFields({ [GLOBAL_JEV_SMART_ZIP_FIELD]: 'yes' })).toBeNull()
  })

  it('names the switch the way the registry and the Settings control do', () => {
    expect(GLOBAL_JEV_SMART_ZIP_LABEL).toBe(TYPESAFE_FEATURES.smart_zip.switchLabel)
    expect(GLOBAL_JEV_SMART_ZIP_LABEL).toBe('Jev Juice: Smart Zip')
  })
})

describe('validateJevJuiceGlobalZipFields', () => {
  it('accepts an absent block, an absent field, and booleans', () => {
    expect(validateJevJuiceGlobalZipFields(undefined)).toBeNull()
    expect(validateJevJuiceGlobalZipFields(null)).toBeNull()
    expect(validateJevJuiceGlobalZipFields({ zip_tool_notes_enabled: true })).toBeNull()
    expect(validateJevJuiceGlobalZipFields({ [GLOBAL_JEV_SMART_ZIP_FIELD]: true })).toBeNull()
    expect(validateJevJuiceGlobalZipFields({ [GLOBAL_JEV_SMART_ZIP_FIELD]: false })).toBeNull()
  })

  it('refuses anything else loudly, naming the switch', () => {
    expect(validateJevJuiceGlobalZipFields({ [GLOBAL_JEV_SMART_ZIP_FIELD]: 'on' })).toMatch(/Jev Juice: Smart Zip.*true or false/)
    expect(validateJevJuiceGlobalZipFields({ [GLOBAL_JEV_SMART_ZIP_FIELD]: 1 })).toMatch(/true or false/)
    expect(validateJevJuiceGlobalZipFields({ [GLOBAL_JEV_SMART_ZIP_FIELD]: null })).toMatch(/true or false/)
  })
})

describe('resolveJevIncomingTextScreenEnabled (SA-120 P7, the ONE instance switch)', () => {
  it('is OFF unless the instance config holds literal true', () => {
    expect(resolveJevIncomingTextScreenEnabled(null)).toBe(false)
    expect(resolveJevIncomingTextScreenEnabled(undefined)).toBe(false)
    expect(resolveJevIncomingTextScreenEnabled({})).toBe(false)
    // The master switch alone turns no feature on.
    expect(resolveJevIncomingTextScreenEnabled({ enabled: true })).toBe(false)
    expect(resolveJevIncomingTextScreenEnabled({ [JEV_INCOMING_TEXT_SCREEN_FIELD]: false })).toBe(false)
    expect(resolveJevIncomingTextScreenEnabled({ [JEV_INCOMING_TEXT_SCREEN_FIELD]: 'true' })).toBe(false)
    expect(resolveJevIncomingTextScreenEnabled({ [JEV_INCOMING_TEXT_SCREEN_FIELD]: 1 })).toBe(false)
    expect(resolveJevIncomingTextScreenEnabled({ [JEV_INCOMING_TEXT_SCREEN_FIELD]: true })).toBe(true)
  })

  it('is an instance switch on purpose: an agent record or the zip settings carrying the field turn nothing on', () => {
    expect(resolveAgentJevSkillToolHintsEnabled({ [JEV_INCOMING_TEXT_SCREEN_FIELD]: true })).toBe(false)
    expect(resolveJevSmartZipEnabled({ [JEV_INCOMING_TEXT_SCREEN_FIELD]: true })).toBe(false)
    expect(validateJevJuiceAgentFields({ [JEV_INCOMING_TEXT_SCREEN_FIELD]: 'yes' })).toBeNull()
  })

  it('names the switch the way the registry and the Admin card do', () => {
    expect(JEV_INCOMING_TEXT_SCREEN_FIELD).toBe('screenIncomingText')
    expect(JEV_INCOMING_TEXT_SCREEN_LABEL).toBe(TYPESAFE_FEATURES.untrusted_text.switchLabel)
    expect(JEV_INCOMING_TEXT_SCREEN_LABEL).toBe('Screen Incoming Text')
  })
})
