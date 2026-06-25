<script lang="ts">
  import { Camera } from '@lucide/svelte'
  import ImageTool from '../templates/ImageTool.svelte'
  import ImageRenderer from '../../content/ImageRenderer.svelte'
  import type { ToolData } from '../toolRendererRegistry'

  let { tool } = $props<{ tool: ToolData }>()
  let collapsed = $state(true)

  function parseMaybeJson(value: any): any {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }

  function normalizeCommandName(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^\w]/g, '')
  }

  function isHttpImageUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false
    const trimmed = value.trim()
    if (!trimmed) return false
    return trimmed.startsWith('https://') || trimmed.startsWith('http://')
  }

  function extractScreenshotUrl(value: any): string | null {
    const parsed = parseMaybeJson(value)
    const queue: any[] = [parsed]
    const seen = new Set<any>()

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current || seen.has(current)) continue
      seen.add(current)

      if (typeof current === 'string') {
        if (isHttpImageUrl(current)) return current.trim()
        continue
      }

      if (Array.isArray(current)) {
        for (const entry of current) queue.push(entry)
        continue
      }

      if (typeof current !== 'object') continue

      const directCandidates = [
        (current as any).screenshotUrl,
        (current as any).screenshot_url,
        (current as any).url,
        (current as any).externalUrl,
        (current as any).modelImageUrl
      ]
      for (const candidate of directCandidates) {
        if (isHttpImageUrl(candidate)) return candidate.trim()
      }

      queue.push((current as any).result)
      queue.push((current as any).output)
      queue.push((current as any).data)
      queue.push((current as any).content)
      queue.push((current as any).value)
    }

    return null
  }

  function resolveScreenshotState(toolData: ToolData) {
    const toolResult = parseMaybeJson(toolData?.toolResult)
    const toolInput = parseMaybeJson(toolData?.toolInput)
    const commandCandidates = [
      (toolResult as any)?.command,
      (toolResult as any)?.toolName,
      (toolInput as any)?.toolName
    ]
    const command = commandCandidates.find((candidate) => typeof candidate === 'string') || ''
    const normalizedCommand = normalizeCommandName(command)
    const screenshotUrl = extractScreenshotUrl(toolResult)
    const warning =
      typeof (toolResult as any)?.warning === 'string'
        ? (toolResult as any).warning
        : screenshotUrl
          ? null
          : 'No external screenshot URL available.'

    return {
      isScreenshot: normalizedCommand === 'screenshot',
      screenshotUrl,
      warning
    }
  }

  const screenshotState = $derived(resolveScreenshotState(tool))
  const title = $derived(tool?.displayToolName || tool?.toolName || 'Agent Browser')
  const status = $derived(tool?.success === false ? 'error' : 'success')
</script>

<ImageTool {title} subtitle="Agent Browser Screenshot" icon={Camera} bind:collapsed {status}>
  <div class="screenshot-tool-body">
    {#if screenshotState.isScreenshot && screenshotState.screenshotUrl}
      <ImageRenderer
        src={screenshotState.screenshotUrl}
        alt="Agent Browser screenshot"
        title="Agent Browser screenshot"
        sessionId={tool?.metadata?.sessionId}
      />
    {:else if screenshotState.warning}
      <div class="screenshot-status">{screenshotState.warning}</div>
    {:else}
      <div class="screenshot-status">Screenshot captured.</div>
    {/if}
  </div>
</ImageTool>

<style>
  .screenshot-tool-body {
    padding: 0.5rem;
  }

  .screenshot-status {
    padding: 0.5rem;
    font-size: 0.85rem;
    color: var(--muted-foreground);
  }
</style>
