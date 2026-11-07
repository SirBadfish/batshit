import { describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'

import {
  assertManagedProfileId,
  isManagedProfileId,
  ManagedProfileIdRefusedError,
  MANAGED_PROFILE_ID_REFUSED
} from '../managedAgentHome'
import { buildAgentProfileId } from '../managedProfileIdentity'

/**
 * BL-7 review — the lane-neutral managed-home rules (SA-139 R1 moved them out of the retired
 * Codex lane's module): which profile ids may name a folder under Batshit's agents folder. SA-139
 * R5 removed the last profile writer, and with it the link-safe file read and write; the delete's
 * own checks (`describeUnmanagedAgentHome`) are pinned in `claudeManagedHome.test.ts`.
 */

describe('the managed profile id rule', () => {
  it('accepts every profile id Batshit builds', async () => {
    const {
      buildCliSubagentRuntimeId,
      buildCliWorkerRuntimeId,
      normalizeSubagentSlugValue,
      resolveSubagentSlug
    } = await import('$lib/utils/subagentSlug')
    const built = [
      // A Primary Agent's own profile (the chat run and the compact worker).
      buildAgentProfileId('agent-1'),
      buildAgentProfileId('josh_main'),
      buildAgentProfileId('Josh Main Agent!'),
      buildAgentProfileId('agent_1726000000000_AbC'),
      buildAgentProfileId('../..'),
      buildAgentProfileId(null),
      // A CLI Subagent's profile.
      buildAgentProfileId(buildCliSubagentRuntimeId(resolveSubagentSlug({ slug: 'research-helper' }))),
      buildAgentProfileId(
        buildCliSubagentRuntimeId(resolveSubagentSlug({ displayName: 'Écrit / Helper ../x' }))
      ),
      // A Worker's profile (one slot per position, scoped to the parent agent; BL-285).
      buildAgentProfileId(
        buildCliWorkerRuntimeId(`worker_${normalizeSubagentSlugValue('Josh-Main', 'agent')}_1`)
      ),
      // The bridge's own fallbacks.
      'batshit_agent_default',
      `batshit_agent_${'agent-123'}`
    ]

    for (const profileId of built) {
      expect(isManagedProfileId(profileId), profileId).toBe(true)
      expect(assertManagedProfileId(profileId)).toBe(profileId)
    }
  })

  it('refuses anything with a separator, a dot, or another shape, with a readable managed-profile refusal', () => {
    const refused = [
      '../..',
      '..',
      '/Users/someone/.claude',
      path.join(os.tmpdir(), '.claude'),
      'batshit_agent_x/../..',
      'batshit_agent_x/nested',
      'batshit_agent_x\\nested',
      'batshit_agent_../..',
      'batshit_agent_..',
      'batshit_agent_x\\..\\..',
      'batshit_agent_a.b',
      'batshit_agent_',
      'batshit_agent_X',
      'batshit_agent_a b',
      ' batshit_agent_x',
      'batshit_agent_x' + String.fromCharCode(10),
      'batshit_agent_x' + String.fromCharCode(0),
      'other_prefix_x',
      '',
      null,
      undefined,
      42
    ]

    for (const profileId of refused) {
      expect(isManagedProfileId(profileId), String(profileId)).toBe(false)
      let refusal: unknown
      try {
        assertManagedProfileId(profileId)
      } catch (error) {
        refusal = error
      }
      expect(refusal, String(profileId)).toBeInstanceOf(ManagedProfileIdRefusedError)
      expect((refusal as ManagedProfileIdRefusedError).code).toBe(MANAGED_PROFILE_ID_REFUSED)
      expect((refusal as Error).message).toMatch(/refused to use .* as a managed profile/)
    }
  })
})
