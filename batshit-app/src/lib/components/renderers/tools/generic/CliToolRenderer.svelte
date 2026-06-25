<script lang="ts">
  import { Terminal } from '@lucide/svelte'

  import FullTool from '../templates/FullTool.svelte'
  import type { ToolData } from '../toolRendererRegistry'

  let { tool }: { tool: ToolData } = $props()

  function asObject(value: unknown): Record<string, any> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, any>
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, any>
        }
      } catch {
        // ignore
      }
    }
    return {}
  }

  const payload = $derived(asObject(tool.toolResult))
  const title = $derived(payload.title || payload.toolId || tool.displayToolName || tool.toolName || 'CLI Tool')
  const subtitle = $derived(payload.toolId || '')
  const status = $derived((tool.success ? 'success' : 'error') as 'success' | 'error' | 'info' | 'loading')
  const stdout = $derived(typeof payload.stdout === 'string' ? payload.stdout : '')
  const stderr = $derived(typeof payload.stderr === 'string' ? payload.stderr : '')
  const parsedOutput = $derived(payload.parsedOutput)
  const metadata = $derived({
    ...(payload.executable ? { Executable: payload.executable } : {}),
    ...(payload.exitCode !== undefined ? { 'Exit Code': payload.exitCode } : {}),
    ...(payload.outputMode ? { Output: payload.outputMode } : {}),
    ...(payload.parseMode ? { Parse: payload.parseMode } : {}),
    ...(payload.durationMs !== undefined ? { 'Duration (ms)': payload.durationMs } : {}),
    ...(payload.rawSidecar?.zipId ? { 'Raw Payload Zip': payload.rawSidecar.zipId } : {})
  })
</script>

<FullTool
  icon={Terminal}
  {title}
  {subtitle}
  {status}
  error={tool.error || payload.error}
  metadata={metadata}
>
  <div class="stack">
    {#if Array.isArray(payload.args) && payload.args.length > 0}
      <div class="block">
        <div class="label">Args</div>
        <pre>{payload.args.join(' ')}</pre>
      </div>
    {/if}

    {#if payload.cwd}
      <div class="block">
        <div class="label">Working Directory</div>
        <pre>{payload.cwd}</pre>
      </div>
    {/if}

    {#if stdout}
      <div class="block">
        <div class="label">Stdout</div>
        <pre>{stdout}</pre>
      </div>
    {/if}

    {#if stderr}
      <div class="block">
        <div class="label">Stderr</div>
        <pre>{stderr}</pre>
      </div>
    {/if}

    {#if parsedOutput !== undefined}
      <div class="block">
        <div class="label">Parsed Output</div>
        <pre>{JSON.stringify(parsedOutput, null, 2)}</pre>
      </div>
    {/if}
  </div>
</FullTool>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .block {
    background: var(--muted);
    border-radius: 0.35rem;
    padding: 0.75rem;
  }
  .label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted-foreground);
    margin-bottom: 0.35rem;
  }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
    line-height: 1.5;
  }
</style>
