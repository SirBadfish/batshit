import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

describe('Tool Grid surface contracts', () => {
  const globalCliDetailsControlPattern =
    /handleCliToolToggle\(tool\.toolId, checked === true\)[\s\S]*?<td class="batshit-settings-table-cell">\s*\{#if !toolDisableReason\}\s*<Select\.Root/

  const agentCliDetailsControlPattern =
    /handleCliToolVisibilityToggle\(tool\.toolId, checked === true\)[\s\S]*?<td class="batshit-settings-table-cell">\s*\{#if !disableReason\}\s*<Select\.Root/

  it('labels global zip fallbacks as defaults instead of parent inheritance', () => {
    const source = readSource('src/lib/components/mcps/GlobalToolGrid.svelte')

    expect(source).toContain(
      "formatToolGridZipBehaviorLabel(value, inheritedAutoZip, inheritedZipDisabled, 'default')"
    )
    expect(source).not.toContain('Inherit ({getInheritedZipBehaviorLabel')
  })

  it('keeps Tool Grid reset actions broad and inheritance-focused', () => {
    const globalSource = readSource('src/lib/components/mcps/GlobalToolGrid.svelte')
    const agentSource = readSource(
      'src/lib/components/settings/agent/AgentMcpDefaultsCard.svelte'
    )

    expect(globalSource).toContain('Reset to defaults')
    expect(agentSource).toContain('Reset to global settings')
    expect(agentSource).not.toContain('Reset all zip overrides')
    expect(agentSource).not.toContain('Clear discoverability defaults')
  })

  it('uses chat-consistent Zip Behavior icons', () => {
    const sources = [
      readSource('src/lib/components/mcps/GlobalToolGrid.svelte'),
      readSource('src/lib/components/settings/agent/AgentMcpDefaultsCard.svelte'),
      readSource('src/lib/components/mcps/NonMcpZipRowsSection.svelte')
    ]

    for (const source of sources) {
      expect(source).toContain('BatshitIcon')
      expect(source).toContain('id="zip"')
      expect(source).toContain('Clock3')
      expect(source).toContain('Infinity')
      expect(source).not.toContain('CircleX')
      expect(source).not.toContain('CircleMinus')
      expect(source).not.toContain('CircleCheck')
      expect(source).not.toContain('<Ban')
    }
  })

  it('keeps CLI per-tool detail controls available while an individual CLI tool is off', () => {
    const globalSource = readSource('src/lib/components/mcps/GlobalToolGrid.svelte')
    const agentSource = readSource(
      'src/lib/components/settings/agent/AgentMcpDefaultsCard.svelte'
    )

    expect(globalSource).toMatch(globalCliDetailsControlPattern)
    expect(agentSource).toMatch(agentCliDetailsControlPattern)
  })
})
