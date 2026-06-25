<script lang="ts">
  import { tick } from 'svelte'
  import Prism from 'prismjs'
  import { Button } from '$lib/components/ui/button'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { escapeStructuredTextContent } from '$lib/utils/htmlEntities'
  import '$lib/styles/prism-themes.css'

  const PRISM_HIGHLIGHT_MAX_CHARS = 50_000
  const PRISM_HIGHLIGHT_MAX_LINES = 1_500

  const PRISM_LANGUAGE_LOADERS: Array<() => Promise<unknown>> = [
    // Core + shared grammars
    () => import('prismjs/components/prism-clike.js'),
    () => import('prismjs/components/prism-markup.js'),
    () => import('prismjs/components/prism-markup-templating.js'),

    // Web / scripts
    () => import('prismjs/components/prism-javascript.js'),
    () => import('prismjs/components/prism-typescript.js'),
    () => import('prismjs/components/prism-jsx.js'),
    () => import('prismjs/components/prism-tsx.js'),
    () => import('prismjs/components/prism-bash.js'),
    () => import('prismjs/components/prism-powershell.js'),
    () => import('prismjs/components/prism-batch.js'),

    // Data / config
    () => import('prismjs/components/prism-json.js'),
    () => import('prismjs/components/prism-json5.js'),
    () => import('prismjs/components/prism-yaml.js'),
    () => import('prismjs/components/prism-toml.js'),
    () => import('prismjs/components/prism-ini.js'),
    () => import('prismjs/components/prism-properties.js'),
    () => import('prismjs/components/prism-markdown.js'),
    () => import('prismjs/components/prism-diff.js'),
    () => import('prismjs/components/prism-sql.js'),

    // Styles/templates
    () => import('prismjs/components/prism-css.js'),
    () => import('prismjs/components/prism-css-extras.js'),
    () => import('prismjs/components/prism-scss.js'),
    () => import('prismjs/components/prism-sass.js'),
    () => import('prismjs/components/prism-less.js'),

    // Backend / general purpose
    () => import('prismjs/components/prism-python.js'),
    () => import('prismjs/components/prism-go.js'),
    () => import('prismjs/components/prism-rust.js'),
    () => import('prismjs/components/prism-java.js'),
    () => import('prismjs/components/prism-kotlin.js'),
    () => import('prismjs/components/prism-c.js'),
    () => import('prismjs/components/prism-cpp.js'),
    () => import('prismjs/components/prism-csharp.js'),
    () => import('prismjs/components/prism-php.js'),
    () => import('prismjs/components/prism-ruby.js'),
    () => import('prismjs/components/prism-swift.js'),
    () => import('prismjs/components/prism-graphql.js'),
    () => import('prismjs/components/prism-docker.js'),
    () => import('prismjs/components/prism-makefile.js'),
    () => import('prismjs/components/prism-protobuf.js'),
    () => import('prismjs/components/prism-hcl.js'),
    () => import('prismjs/components/prism-lua.js'),
    () => import('prismjs/components/prism-dart.js'),
    () => import('prismjs/components/prism-scala.js'),
    () => import('prismjs/components/prism-r.js'),
    () => import('prismjs/components/prism-ignore.js')
  ]

  let prismLanguagesPromise: Promise<void> | null = null

  function ensurePrismLanguages() {
    if (typeof window === 'undefined') return Promise.resolve()
    if (!prismLanguagesPromise) {
      ;(globalThis as typeof globalThis & { Prism?: typeof Prism }).Prism = Prism
      prismLanguagesPromise = PRISM_LANGUAGE_LOADERS.reduce(
        (promise, loadLanguage) => promise.then(() => loadLanguage()).then(() => undefined),
        Promise.resolve()
      )
    }
    return prismLanguagesPromise
  }

  let {
    content,
    language = 'text',
    showCopyButton = true,
    showLineNumbers = true,
    codeTheme = 'okaidia',
    targetLineNumber = null,
    instanceKey = ''
  } = $props<{
    content: string
    language?: string
    showCopyButton?: boolean
    showLineNumbers?: boolean
    codeTheme?: 'okaidia' | 'twilight'
    targetLineNumber?: number | null
    instanceKey?: string
  }>()

  let highlightedHtml = $state('')
  let copied = $state(false)
  let isDiff = $state(false)
  let preElement = $state<HTMLPreElement | null>(null)

  const normalizedLanguage = $derived.by(() => {
    const lang = (language || 'text').toLowerCase()
    if (['sh', 'shell', 'zsh'].includes(lang)) return 'bash'
    if (lang === 'yml') return 'yaml'
    if (['md', 'mdx'].includes(lang)) return 'markdown'
    if (lang === 'svelte') return 'markup'
    if (lang === 'vue') return 'markup'
    if (lang === 'terraform') return 'hcl'
    if (['env', 'dotenv', 'properties', 'conf', 'cfg', 'ini'].includes(lang)) return 'properties'
    if (lang === 'gitignore') return 'ignore'
    if (lang === 'dockerfile') return 'docker'
    return lang
  })

  function detectDiffFlag(raw: string, lang: string) {
    if (lang === 'diff') return true
    if (!raw) return false
    const lines = raw.split('\n')
    let indicators = 0
    if (lines.some((l) => l.startsWith('diff --git') || l.startsWith('@@'))) indicators += 2
    const addLines = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    const delLines = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
    if ((addLines > 0 && delLines > 0) || addLines > 3 || delLines > 3) indicators += 1
    return indicators >= 2
  }

  async function copyToClipboard() {
    if (!content) return
    try {
      await copyTextToClipboard(content)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch (error) {
      console.error('Copy failed', error)
    }
  }

  function highlight() {
    if (!content) {
      highlightedHtml = ''
      return
    }

    const lang = normalizedLanguage
    isDiff = detectDiffFlag(content, lang)

    const grammar = Prism.languages[isDiff ? 'diff' : lang] || Prism.languages.markup

    const rawLines = content.split('\n')
    const usePlainText =
      content.length > PRISM_HIGHLIGHT_MAX_CHARS ||
      rawLines.length > PRISM_HIGHLIGHT_MAX_LINES
    const highlightedLines = rawLines.map((line: string) =>
      usePlainText ? escapeStructuredTextContent(line) : Prism.highlight(line, grammar, isDiff ? 'diff' : lang)
    )

    const combined = highlightedLines.map((line: string, idx: number) => {
      const rawLine = rawLines[idx] || ''
      const diffClass = rawLine.startsWith('+') && !rawLine.startsWith('+++')
        ? 'diff-add'
        : rawLine.startsWith('-') && !rawLine.startsWith('---')
          ? 'diff-remove'
          : rawLine.startsWith('@@')
            ? 'diff-marker'
            : ''

      const safeLine = line.length ? line : '&nbsp;'
      const lineNumber = idx + 1
      const targetClass = targetLineNumber === lineNumber ? ' target-line' : ''
      const lineNumberSpan = `<span class="line-number">${lineNumber}</span>`
      const lineContentSpan = `<span class="line-content">${safeLine}</span>`
      return `<span class="line ${diffClass}${targetClass}" data-line-number="${lineNumber}">${lineNumberSpan}${lineContentSpan}</span>`
    }).join('')

    highlightedHtml = combined
  }

  // Re-highlight when inputs change
  $effect(() => {
    const deps = { content, language: normalizedLanguage, targetLineNumber, instanceKey }
    highlight()
    void ensurePrismLanguages()
      .then(highlight)
      .catch((error) => console.error('[PrismCodeBlock] Failed to load Prism languages:', error))
  })

  $effect(() => {
    const deps = { highlightedHtml, targetLineNumber, preElement }
    if (!targetLineNumber || !preElement || !highlightedHtml) return

    void tick().then(() => {
      const line = preElement?.querySelector(`[data-line-number="${targetLineNumber}"]`)
      if (line instanceof HTMLElement) {
        line.scrollIntoView({ block: 'center', inline: 'nearest' })
      }
    })
  })

  // Watch for theme switch via data-code-theme on documentElement
  if (typeof window !== 'undefined') {
    $effect(() => {
      const updateThemeFromAttr = () => {
        const attr = document.documentElement.getAttribute('data-code-theme')
        if (attr === 'twilight' || attr === 'okaidia') {
          codeTheme = attr
        }
      }
      updateThemeFromAttr()
      const observer = new MutationObserver(updateThemeFromAttr)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-code-theme']
      })
      return () => observer.disconnect()
    })
  }
</script>

<div class={`prism-code-block prism-theme-${codeTheme} ${showLineNumbers ? '' : 'no-line-numbers'} ${isDiff ? 'is-diff' : ''}`}>
  {#if showCopyButton}
    <div class="code-actions">
      <Button variant="ghost" size="sm" onclick={copyToClipboard} class="copy-button">
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  {/if}

  <pre class="prism-pre" bind:this={preElement}><code class={`language-${normalizedLanguage}`}>{@html highlightedHtml || '<span class=\"line\"><span class=\"line-number\">1</span><span class=\"line-content\">[No content]</span></span>'}</code></pre>
</div>

<style>
  .prism-code-block {
    --prism-bg-color: var(--prism-bg, var(--muted));
    --prism-fg-color: var(--prism-fg, var(--foreground));
    --prism-border-color: var(--prism-border, rgba(255, 255, 255, 0.07));
    --prism-line-number-color: var(--prism-line-number, rgba(255, 255, 255, 0.6));

    position: relative;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    font-size: 0.88rem;
    line-height: 1.3;
    border-radius: var(--radius);
    background: var(--prism-bg-color);
    color: var(--prism-fg-color);
    border: 1px solid var(--prism-border-color);
    overflow: hidden;
  }

  .code-actions {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    z-index: 5;
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(6px);
    border: 1px solid var(--prism-border-color);
    border-radius: 0.55rem;
    padding: 0.1rem;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  :global(.prism-code-block .copy-button) {
    background: rgba(20, 20, 20, 0.92);
    border: 1px solid var(--prism-border-color);
    border-radius: 0.45rem;
  }

  :global(.prism-code-block:hover .code-actions) {
    opacity: 1;
  }

  .prism-pre {
    margin: 0;
    padding: 0.5rem 0;
    overflow: hidden;
    background: var(--prism-bg-color);
  }

  .prism-pre code {
    display: block;
    padding: 0;
    background: transparent;
    color: var(--prism-fg-color);
    tab-size: 2;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  :global(.prism-code-block .line) {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.45rem;
    row-gap: 0.02rem;
    line-height: 1.28;
    padding: 0.02rem 0.9rem 0.02rem 0.8rem;
    position: relative;
    align-items: baseline;
  }

  :global(.prism-code-block .line-number) {
    color: var(--prism-line-number-color);
    opacity: 1;
    width: 2rem;
    text-align: right;
    user-select: none;
    font-size: 0.74rem;
    padding-right: 0.45rem;
    border-right: 1px solid var(--prism-border-color);
  }

  :global(.prism-code-block.no-line-numbers .line-number) {
    display: none;
  }

  :global(.prism-code-block.no-line-numbers .line) {
    grid-template-columns: 1fr;
    padding-left: 1rem;
  }

  :global(.prism-code-block .line-content) {
    flex: 1;
    min-width: 0;
    word-break: break-word;
    white-space: pre-wrap;
  }

  :global(.prism-code-block .line:not(.diff-add):not(.diff-remove):not(.diff-marker):hover) {
    background-color: rgba(255, 255, 255, 0.03);
  }

  :global(.prism-code-block .line.target-line) {
    background: color-mix(in oklch, var(--bs-app-primary, hsl(var(--primary))) 28%, transparent);
    box-shadow: inset 2px 0 0 color-mix(in oklch, var(--bs-app-primary, hsl(var(--primary))) 80%, oklch(0.94 0.006 289.95));
  }

  /* Diff styles */
  :global(.prism-code-block.is-diff .line.diff-add) {
    background-color: rgba(46, 160, 67, 0.12);
  }

  :global(.prism-code-block.is-diff .line.diff-remove) {
    background-color: rgba(248, 81, 73, 0.12);
  }

  :global(.prism-code-block.is-diff .line.diff-marker) {
    background-color: rgba(84, 174, 255, 0.12);
  }

  /* Scrollbar */
  :global(.prism-pre::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }
  :global(.prism-pre::-webkit-scrollbar-track) {
    background: transparent;
  }
  :global(.prism-pre::-webkit-scrollbar-thumb) {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 9999px;
  }
  :global(.prism-pre::-webkit-scrollbar-thumb:hover) {
    background: rgba(255, 255, 255, 0.35);
  }
</style>
