import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

describe('CLI Tools settings surface contracts', () => {
  it('keeps CLI tool creation agent-managed instead of manual button driven', () => {
    const source = readSource('src/lib/components/tools/CliToolsManager.svelte')

    expect(source).not.toContain('Ask Agent To Set This Up')
    expect(source).not.toContain('Create Manually')
    expect(source).not.toContain('CliToolEditorDialog')
  })

  it('keeps only display and safety fields editable in the inline CLI tool card', () => {
    const source = readSource('src/lib/components/tools/CliToolInlineSettingsCard.svelte')

    expect(source).toContain('bind:value={title}')
    expect(source).toContain('bind:value={iconRef}')
    expect(source).toContain('bind:value={tagsText}')
    expect(source).toContain('bind:value={allowedPathsText}')
    expect(source).toContain('Allow Network')
    expect(source).toContain('Allow Write')
    expect(source).toContain('Saved Key Env Refs')

    expect(source).not.toContain('bind:value={executable}')
    expect(source).not.toContain('bind:value={argsTemplateText}')
    expect(source).not.toContain('bind:value={inputSchemaText}')
    expect(source).not.toContain('bind:value={validationInputText}')
    expect(source).not.toContain('bind:value={helpCommandText}')
    expect(source).not.toContain('bind:value={examplesText}')
  })

  it('lets the settings sheet own Tools panel scrolling', () => {
    const source = readSource('src/lib/components/settings/panels/MCPSettingsPanel.svelte')

    expect(source).toContain("mode === 'page' ? 'overflow-auto' : ''")
  })
})
