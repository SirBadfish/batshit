import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

describe('AB home control labels', () => {
  it('keeps critical chatbar controls machine-addressable', () => {
    const source = readSource('src/lib/components/chat/ChatInput.svelte')

    expect(source).toContain('data-ab-control="message-input"')
    expect(source).not.toContain('data-ab-control="open-n8n-agent"')
    expect(source).not.toContain('data-ab-control="toggle-test-mode"')
    expect(source).toContain('data-ab-control="open-execution-viewer"')
    expect(source).toContain('data-ab-control="work-mode"')
    expect(source).toContain('data-ab-control="codex-permission-mode"')
    expect(source).toContain('data-ab-control="claude-permission-mode"')
    expect(source).not.toContain('data-ab-control="n8n-workflow-mode"')
    expect(source).toContain('data-ab-control="voice-input-once"')
    expect(source).toContain('data-ab-control="voice-mode-toggle"')
    expect(source).not.toContain('data-ab-control="livekit-voice-room-toggle"')
    expect(source).toContain('data-ab-control="stop-current-run"')
    expect(source).toContain('data-ab-control="send-message"')
  })

  it('keeps send gated while one-shot dictation is finalizing', () => {
    const source = readSource('src/lib/components/chat/ChatInput.svelte')

    expect(source).toContain('let finalizingDictation = $state(false)')
    expect(source).toContain('const pendingDictation = dictationPromise')
    expect(source).toContain('if (!isListening && !pendingDictation) return true')
    expect(source).toContain('await pendingDictation')
    expect(source).toContain('await tick()')
    expect(source).toContain('const sendDisabled = $derived(disabled || !message.trim() || finalizingDictation)')
    expect(source).toContain('disabled={sendDisabled}')
  })

  it('uses waveform feedback instead of browser draft text for recorded dictation', () => {
    const source = readSource('src/lib/components/chat/ChatInput.svelte')

    expect(source).toContain('const dictationActivityPreviewVisible = $derived')
    expect(source).toContain('const composerVoiceActivityPreviewVisible = $derived')
    expect(source).toContain("detail?.source !== 'dictation'")
    expect(source).toContain("const dictationShowsLiveTranscript = transcribeSttProvider === 'browser'")
    expect(source).toContain('dictationActivityPreviewPending = !dictationShowsLiveTranscript')
    expect(source).toContain('const handleDictationInterim = dictationShowsLiveTranscript')
    expect(source).toContain('handleDictationInterim,')
  })

  it('keeps direct Voice Mode session controls explicit', () => {
    const source = readSource('src/lib/components/chat/ChatInput.svelte')

    expect(source).toContain('data-ab-control="voice-mode-session"')
    expect(source).toContain('End Voice Mode')
    expect(source).toContain('Auto Listen is on. Batshit will listen when it is your turn.')
    expect(source).toContain('Tap to record your next voice turn.')
    expect(source).toContain('Text Input Voice Mode enabled. Replies will be spoken.')
    expect(source).toContain('Start Voice Mode with composer text input and spoken replies')
    expect(source).toContain('Stop the spoken reply and keep Voice Mode on')
    expect(source).toContain('batshit:voice-input-activity')
    expect(source).toContain('<CircleDot class="chat-input-action-icon" />')
    expect(source).toContain('handleVoiceModeInputActivity(detail.source)')
    expect(source).toContain('const voiceModeSessionPillActive = $derived')
    expect(source).toContain("detail?.source !== 'voice-mode'")
    expect(source).toContain("detail?.source !== 'livekit'")
    expect(source).toContain("detail?.source !== 'dictation'")
    expect(source).toContain('recordedVoiceModeAutoStopTimer')
    expect(source).toContain('voiceModeActivityPreviewActive')
    expect(source).toContain('recordedVoiceModeCaptureFinalizing')
    expect(source).toContain('is-voice-speaking')
    expect(source).not.toContain('is-voice-turn-ready')
  })

  it('keeps sidebar, project, token, and widget menu controls labeled', () => {
    const sidebar = readSource('src/lib/components/batshit-sidebar/batshit-sidebar.svelte')
    const projectSelector = readSource('src/lib/components/projects/ProjectSelector.svelte')
    const projectsSidebar = readSource('src/lib/components/projects/ProjectsSidebar.svelte')
    const clipsManager = readSource('src/lib/components/clips/ClipsManagerDropdown.svelte')
    const zipsManager = readSource('src/lib/components/zips/ZipsManagerDropdown.svelte')
    const mcpDropdown = readSource('src/lib/components/mcps/MCPsDropdown.svelte')
    const tokenPanel = readSource('src/lib/components/tokens/TokenPanel.svelte')
    const compactArtifactShelf = readSource('src/lib/components/artifacts/CompactArtifactShelf.svelte')
    const headerBarIcons = readSource('src/lib/components/artifacts/HeaderBarIcons.svelte')
    const agentSelector = readSource('src/lib/components/agents/AgentSelector.svelte')
    const codexReasoningSelector = readSource(
      'src/lib/components/models/CodexReasoningEffortSelector.svelte'
    )

    expect(sidebar).toContain('data-ab-control="toggle-archives"')
    expect(sidebar).toContain('data-ab-control="open-user-settings"')
    expect(sidebar).toContain('data-ab-control="open-settings"')

    expect(projectSelector).toContain('data-ab-control="project-selector"')
    expect(projectsSidebar).toContain('data-ab-control="projects-sidebar-toggle"')
    expect(projectsSidebar).toContain('data-ab-control="manage-projects"')
    expect(projectsSidebar).toContain('data-ab-control="refresh-file-tree"')
    expect(clipsManager).toContain('data-ab-control="manage-clips"')
    expect(clipsManager).toContain('clips-manager-tunnel-attention-dot')
    expect(zipsManager).toContain('data-ab-control="manage-zips"')
    expect(mcpDropdown).toContain('data-ab-control="tools"')

    expect(tokenPanel).toContain('data-ab-control="token-trim-50k"')
    expect(tokenPanel).toContain('data-ab-control="token-trim-reset"')
    expect(tokenPanel).toContain('data-ab-control="open-execution-viewer"')
    expect(compactArtifactShelf).toContain('data-ab-control="compact-artifact-shelf-toggle"')

    expect(headerBarIcons).toContain('data-ab-control="artifact-widget-menu"')
    expect(headerBarIcons).toContain('Open widget menu')

    expect(agentSelector).toContain('data-ab-control="chat-target"')
    expect(codexReasoningSelector).toContain('data-ab-control="codex-reasoning-effort"')
  })
})
