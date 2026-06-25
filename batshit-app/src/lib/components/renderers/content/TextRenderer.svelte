<script lang="ts">
  import MarkdownRenderer from './MarkdownRenderer.svelte'

  let { content, renderFileMentions = false } = $props<{
    content: string
    renderFileMentions?: boolean
  }>()
</script>

<!-- TextRenderer now just delegates to MarkdownRenderer for ALL text content -->
<MarkdownRenderer {content} {renderFileMentions} />
