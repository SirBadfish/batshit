<script lang="ts">
  import { Image as ImageIcon } from '@lucide/svelte'
  import ImageTool from '../templates/ImageTool.svelte'
  import ImageRenderer from '../../content/ImageRenderer.svelte'
  import { api } from '$lib/services/api'
  import type { ToolData } from '../toolRendererRegistry'

  let { tool } = $props<{ tool: ToolData }>()

  let collapsed = $state(true)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let images = $state<Array<{
    zipId: string
    src: string
    description?: string
    tokens?: number
  }>>([])

  const extractZipId = (ref: string): string | null => {
    const match = ref.match(/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/)
    return match ? match[1] : null
  }

  const parseMaybeJson = (value: any) => {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  const collectImageZipRefs = (value: any, refs: Set<string>) => {
    if (!value) return
    const parsed = parseMaybeJson(value)

    if (Array.isArray(parsed)) {
      parsed.forEach((item) => collectImageZipRefs(item, refs))
      return
    }

    if (parsed && typeof parsed === 'object') {
      const candidates = (parsed as any).imageZipReferences || (parsed as any).image_zip_references
      if (Array.isArray(candidates)) {
        candidates.forEach((ref) => {
          if (typeof ref !== 'string') return
          const zipId = extractZipId(ref)
          if (zipId) refs.add(zipId)
        })
      }

      const nested = (parsed as any).result ?? (parsed as any).output ?? (parsed as any).content
      if (nested && nested !== parsed) {
        collectImageZipRefs(nested, refs)
      }
    }
  }

  async function loadImages() {
    const refs = new Set<string>()
    collectImageZipRefs(tool?.toolResult, refs)

    const zipIds = Array.from(refs)
    if (zipIds.length === 0) {
      images = []
      error = null
      loading = false
      return
    }

    loading = true
    error = null

    try {
      const fetched = await Promise.all(
        zipIds.map(async (zipId) => {
          const zip = await api.getZip(zipId)
          return {
            zipId,
            src: zip?.content || '',
            description: zip?.description || '',
            tokens: zip?.tokens || 0
          }
        })
      )

      images = fetched.filter((img) => Boolean(img.src))
    } catch (err) {
      console.error('[ImageGenerationRenderer] Failed to load image zips:', err)
      images = []
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void loadImages()
  })

  const title = $derived(tool?.displayToolName || tool?.toolName || 'Image Generation')
  const status = $derived(tool?.success === false ? 'error' : 'success')
</script>

<ImageTool {title} subtitle="Image Generation" icon={ImageIcon} bind:collapsed {status}>
  <div class="image-tool-body">
    {#if loading}
      <div class="image-status">Loading image...</div>
    {:else if error}
      <div class="image-status error">Failed to load image: {error}</div>
    {:else if images.length === 0}
      <div class="image-status">No image data found.</div>
    {:else}
      <div class="image-grid">
        {#each images as image (image.zipId)}
          <ImageRenderer
            src={image.src}
            alt={image.description || 'AI-generated image'}
            title={image.description || 'AI-generated image'}
            sessionId={tool?.metadata?.sessionId}
          />
        {/each}
      </div>
    {/if}
  </div>
</ImageTool>

<style>
  .image-tool-body {
    padding: 0;
  }

  .image-status {
    padding: 0.75rem;
    font-size: 0.85rem;
    color: var(--muted-foreground);
  }

  .image-status.error {
    color: oklch(0.6 0.18 27);
  }

  .image-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.5rem;
  }
</style>
