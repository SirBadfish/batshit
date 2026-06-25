<script lang="ts">
  import { Marked, Renderer } from 'marked'
  import DOMPurify from 'dompurify'
  import '$lib/styles/components/markdown.css'
  import CodeRenderer from './CodeRenderer.svelte'
  import { decorateFileMentionsForMarkdown, parseProjectQuickViewHrefTarget } from '$lib/utils/fileMentions'
  import { escapeHtml } from '$lib/utils/htmlEntities'
  import { formatSkillInlineDisplayName } from '$lib/utils/skillInlineNotes'

  let { content, renderFileMentions = false } = $props<{
    content: string
    renderFileMentions?: boolean
  }>()

  const chatMarkdownParser = new Marked({
    breaks: true,
    gfm: true
  })
  
  // Parse markdown and extract structure
  type MarkdownSegment = 
    | { id: string; type: 'html'; content: string }
    | { id: string; type: 'code'; content: string; language: string }

  function decorateSkillNotes(md: string) {
    return md.replace(/\[(Skill|Invoked skill):\s*([^\]\n]+)\]/gi, (_match, _kind, rawLabel) => {
      const label = formatSkillInlineDisplayName(String(rawLabel ?? ''))
      return `<span class="batshit-skill-pill"><span class="batshit-skill-pill-icon"></span><span class="batshit-skill-pill-label">${escapeHtml(label)}</span></span>`
    })
  }

  function parseMarkdown(md: string): MarkdownSegment[] {
    const segments: MarkdownSegment[] = []
    const codeBlocks = new Map<string, { code: string; language: string }>()
    let codeCounter = 0
    const mentionDecoratedMarkdown = renderFileMentions ? decorateFileMentionsForMarkdown(md) : md
    const decoratedMarkdown = decorateSkillNotes(mentionDecoratedMarkdown)
    
    // Create custom renderer with overrides
    const renderer = new Renderer()
    renderer.code = function code(token: any) {
      const code = token.text || ''
      const language = token.lang || 'text'

      const id = `code-${codeCounter++}`
      codeBlocks.set(id, { code, language })
      return `<CODE_BLOCK_${id}>`
    }
    // Markdown image rendering is intentionally disabled in chat.
    renderer.image = function image() {
      return ''
    }
    
    // Parse markdown synchronously
    const html = chatMarkdownParser.parse(decoratedMarkdown, { renderer }) as string
    
    // Wrap tables after parsing
    const htmlWithWrappedTables = html.replace(
      /<table>/g,
      '<div class="table-wrapper"><table>'
    ).replace(
      /<\/table>/g,
      '</table></div>'
    )
    
    // Split HTML by code block markers
    const parts = htmlWithWrappedTables.split(/(<CODE_BLOCK_[^>]+>)/)
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      
      if (part.startsWith('<CODE_BLOCK_')) {
        // Extract code block ID
        const id = part.match(/<CODE_BLOCK_([^>]+)>/)?.[1]
        if (id) {
          const block = codeBlocks.get(id)
          if (block) {
            const trimmed = block.code?.trim() || ''
            if (trimmed.length > 0) {
              segments.push({
                id,
                type: 'code',
                content: block.code,
                language: block.language
              })
            }
          }
        }
      } else if (part.trim()) {
        // HTML content - SANITIZE to prevent XSS attacks
        const sanitizedHtml = DOMPurify.sanitize(part, {
          ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 'del', 'a', 'code', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span'],
          ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel'],
          ALLOW_DATA_ATTR: false,
          ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|file|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
        })
        segments.push({ id: `html-${i}`, type: 'html', content: sanitizedHtml })
      }
    }
    
    return segments
  }
  
  const segments = $derived(parseMarkdown(content))

  function handleMarkdownClick(event: MouseEvent) {
    const target = event.target instanceof Element
      ? event.target.closest('a[href]')
      : null
    if (!(target instanceof HTMLAnchorElement)) return
    const href = target.getAttribute('href') || ''
    const quickViewTarget = parseProjectQuickViewHrefTarget(href)
    if (!quickViewTarget) return

    event.preventDefault()
    window.dispatchEvent(
      new CustomEvent('batshit:project-quick-view', {
        detail: quickViewTarget
      })
    )
  }

  function projectQuickViewLinks(node: HTMLElement) {
    node.addEventListener('click', handleMarkdownClick)
    return {
      destroy() {
        node.removeEventListener('click', handleMarkdownClick)
      }
    }
  }
</script>

<div class="batshit-markdown batshit-markdown-compact" use:projectQuickViewLinks>
  {#each segments as segment (segment.id)}
    {#if segment.type === 'html'}
      {@html segment.content}
    {:else if segment.type === 'code'}
      <div class="code-block-wrapper">
        <CodeRenderer content={segment.content} language={segment.language} />
      </div>
    {/if}
  {/each}
</div>

<style>
  /* Table wrapper for horizontal scrolling */
  :global(.batshit-markdown .table-wrapper) {
    overflow-x: auto;
    margin-top: 0.75rem;
    margin-bottom: 0.75rem;
  }
  
  :global(.batshit-markdown .table-wrapper table) {
    margin: 0;
    width: max-content;
    min-width: 100%;
  }
  
  /* Code block spacing */
  .code-block-wrapper {
    margin-top: 0.75rem;
    margin-bottom: 0.75rem;
  }
  
  .code-block-wrapper:first-child {
    margin-top: 0;
  }
  
  .code-block-wrapper:last-child {
    margin-bottom: 0;
  }
  
  :global(.batshit-markdown a[href^="#batshit-project-file="]) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    max-width: min(18rem, 100%);
    min-height: 1.35rem;
    min-width: 0;
    padding: 0 0.46rem;
    border: 1px solid oklch(0.54 0.032 286 / 0.26);
    border-radius: 999px;
    background: oklch(0.075 0.012 276);
    color: oklch(0.94 0.012 292);
    font-size: 0.82em;
    line-height: 1;
    font-weight: 560;
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;
  }

  :global(.batshit-markdown a[href^="#batshit-project-file="]::before) {
    content: '';
    flex: 0 0 auto;
    width: 0.58rem;
    height: 0.74rem;
    border: 1px solid currentColor;
    border-radius: 0.12rem;
    opacity: 0.7;
    box-shadow: inset -0.16rem 0.16rem 0 color-mix(in oklch, currentColor 16%, transparent);
  }

  :global(.batshit-markdown a[href^="#batshit-project-file="]:hover) {
    border-color: oklch(0.64 0.048 286 / 0.42);
    background: oklch(0.105 0.016 276);
  }
</style>
