<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import AnsiToHtml from 'ansi-to-html'
  import CollapsibleContent from '../shared/CollapsibleContent.svelte'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { Terminal } from '@lucide/svelte'
  
  let { content } = $props<{ content: string }>()
  
  let copied = $state(false)
  
  // Count lines for subtitle
  const lineCount = $derived(content ? content.split('\n').length : 0)
  const subtitle = $derived(`${lineCount} lines`)
  
  async function copyToClipboard() {
    try {
      await copyTextToClipboard(content)
      copied = true
      setTimeout(() => copied = false, 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }
  
  // Configure ANSI to HTML converter with our color scheme
  const convert = new AnsiToHtml({
    fg: '#E1E4E8', // Default foreground
    bg: 'transparent', // Transparent so our CSS background shows through
    newline: true,
    escapeXML: true,
    colors: {
      0: '#6E7681', // Black -> Muted gray
      1: '#FF7B72', // Red
      2: '#7EE787', // Green  
      3: '#FFA657', // Yellow/Orange
      4: '#79C0FF', // Blue
      5: '#D2A8FF', // Magenta/Purple
      6: '#A5D6FF', // Cyan
      7: '#E1E4E8', // White
      8: '#8B949E', // Bright Black -> Medium gray
      9: '#FFA198', // Bright Red
      10: '#AEFF9F', // Bright Green
      11: '#FFCB7D', // Bright Yellow
      12: '#A5D6FF', // Bright Blue
      13: '#E2CBFF', // Bright Magenta
      14: '#B3E5FF', // Bright Cyan
      15: '#FFFFFF'  // Bright White
    }
  })
  
  // Convert ANSI to HTML
  const parsed = $derived(convert.toHtml(content))
</script>

<CollapsibleContent
  title="Terminal Output"
  icon={Terminal}
  {subtitle}
  collapsed={true}
  maxHeight="300px"
>
  <div class="terminal-block">
    <!-- Terminal content -->
    <div class="terminal-content-wrapper">
      <pre class="terminal-pre">{@html parsed}</pre>
      
      <!-- Copy button overlay -->
      <Button
        variant="ghost"
        size="sm"
        onclick={copyToClipboard}
        class="copy-button"
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  </div>
</CollapsibleContent>

<style>
  .terminal-block {
    position: relative;
    width: 100%;
    background: var(--terminal-background, #0d1117);
    border-radius: var(--radius);
    overflow: hidden;
  }
  
  .terminal-content-wrapper {
    position: relative;
    overflow-x: auto;
    width: 100%;
  }
  
  .terminal-pre {
    margin: 0;
    padding: 1rem;
    background: transparent;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--terminal-text, var(--foreground));
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  
  /* Copy button positioning */
  :global(.terminal-block .copy-button) {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    opacity: 0;
    transition: opacity 0.2s;
  }
  
  :global(.terminal-block:hover .copy-button) {
    opacity: 1;
  }
  
  /* Terminal prompt styling */
  .terminal-pre :global(.terminal-prompt-header) {
    color: var(--terminal-prompt-header, #7EE787);
    font-weight: 600;
    opacity: 0.9;
    display: block;
    margin-bottom: 0.25rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid oklch(from var(--muted) l c h / 0.2);
  }
  
  .terminal-pre :global(.terminal-prompt) {
    color: var(--terminal-prompt, #79C0FF);
    font-weight: bold;
    margin-right: 0.5rem;
  }
  
  .terminal-pre :global(.terminal-command) {
    color: var(--terminal-command, #FFA657);
    font-weight: 600;
  }
  
  .terminal-pre :global(.terminal-stderr) {
    color: var(--terminal-error, #FF7B72);
    font-style: italic;
    opacity: 0.9;
  }
  
  .terminal-pre :global(.terminal-success) {
    color: var(--terminal-success, #7EE787);
    font-style: italic;
    opacity: 0.8;
  }
</style>
