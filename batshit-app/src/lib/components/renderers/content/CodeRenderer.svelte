<script lang="ts">
  import CollapsibleContent from '../shared/CollapsibleContent.svelte'
  import { Code, FileDiff } from '@lucide/svelte'
  import PrismCodeBlock from '../shared/PrismCodeBlock.svelte'
  
  let { 
    content, 
    language = 'text', 
    filename,
    toolName,  // Add tool name for proper title display
    path,      // Add path for full file path
    lineCountProp  // Add line count from segment (renamed to avoid conflict)
  } = $props<{ 
    content: string
    language?: string
    filename?: string
    toolName?: string
    path?: string
    lineCountProp?: number
  }>()
  
  let isDiff = $state(false)
  
  // Count lines for subtitle - use prop if available, otherwise calculate
  const lineCount = $derived(lineCountProp || (content ? content.split('\n').length : 0))
  // Create subtitle with language, path/filename, and line count
  const subtitle = $derived.by(() => {
    const parts = []
    
    // Add language if meaningful (but not for diffs since that's redundant)
    if (language && language !== 'text' && language !== 'plaintext' && !isDiff) {
      const langDisplay = language.charAt(0).toUpperCase() + language.slice(1)
      parts.push(langDisplay)
    }
    
    // Add path or filename
    if (path || filename) {
      parts.push(path || filename)
    }
    
    // Add line count
    parts.push(`${lineCount} lines`)
    
    return parts.length > 0 ? parts.join(' • ') : ''
  })
  
  // Check if this is a diff - only for AI-generated content
  $effect(() => {
    const looksLikeDiff = (() => {
      if (language === 'diff') return true
      if (toolName) return false
      if (!content || typeof content !== 'string') return false
      const lines = content.split('\n')
      let indicators = 0
      if (lines.some(line => line.startsWith('diff --git') || line.startsWith('@@'))) indicators += 2
      const addLines = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length
      const delLines = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length
      if ((addLines > 0 && delLines > 0) || addLines > 3 || delLines > 3) indicators++
      return indicators >= 2
    })()
    isDiff = looksLikeDiff
  })
  
  // Get icon based on language or diff status
  function getIcon() {
    if (isDiff) return FileDiff
    return Code
  }
  
  const icon = $derived(getIcon())
  
  // Build simple title: Just the tool name or content type
  const title = $derived.by(() => {
    // Tool name or type
    if (toolName) {
      const toolTitle = 
        toolName === 'write_file' ? 'Write File' :
        toolName === 'read_file' ? 'Read File' :
        toolName === 'edit_file' ? 'Edit File' :
        toolName === 'apply_diff' ? 'Apply Diff' :
        toolName
      return toolTitle
    } else if (isDiff) {
      return 'Diff'
    } else {
      return 'Code'
    }
  })
</script>

<CollapsibleContent
  {title}
  icon={icon}
  {subtitle}
  collapsed={false}
  maxHeight="400px"
>
  <div class="code-block" class:is-diff={isDiff}>
    <div class="code-content-wrapper">
      <PrismCodeBlock
        content={content}
        language={language}
        showCopyButton={true}
        showLineNumbers={true}
        instanceKey={`${language}:${lineCount}:${content.length}`}
      />
    </div>
  </div>
</CollapsibleContent>

<style>
  .code-block {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    border-radius: var(--radius);
    overflow: hidden;
    background-color: var(--muted);
    opacity: 0.75;
  }
  
  /* Selection styling */
  :global(.code-block ::selection) {
    background-color: var(--primary);
    color: var(--primary-foreground);
  }
</style>
