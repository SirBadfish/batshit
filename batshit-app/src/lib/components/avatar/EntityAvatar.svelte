<script lang="ts">
  import AvatarIconRenderer from '$lib/components/icons/AvatarIconRenderer.svelte'
  import type { AvatarIconFit, CustomIconRecord, IconRef } from '$lib/icons/iconTypes'
  import { cn } from '$lib/utils'

  let {
    avatarUrl = null,
    iconRef = null,
    iconFit = 'contain',
    customIcons = [],
    label = '',
    fallback = 'AI',
    class: className = '',
    imageClass = '',
    iconClass = '',
    fillIconClass = 'batshit-avatar-icon-fill',
    initialsClass = ''
  }: {
    avatarUrl?: string | null
    iconRef?: IconRef | null
    iconFit?: AvatarIconFit | null
    customIcons?: CustomIconRecord[]
    label?: string | null
    fallback?: string
    class?: string
    imageClass?: string
    iconClass?: string
    fillIconClass?: string
    initialsClass?: string
  } = $props()

  let failedAvatarUrl = $state<string | null>(null)

  const resolvedAvatarUrl = $derived(
    typeof avatarUrl === 'string' && avatarUrl.trim().length > 0 ? avatarUrl.trim() : null
  )
  const shouldShowImage = $derived(Boolean(resolvedAvatarUrl && failedAvatarUrl !== resolvedAvatarUrl))
  const title = $derived(label?.trim() || fallback)
  const initials = $derived(getInitials(title, fallback))

  function getInitials(value: string | null | undefined, fallbackValue: string) {
    const source = value?.trim() || fallbackValue
    return source
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  function handleImageError() {
    failedAvatarUrl = resolvedAvatarUrl
  }
</script>

<span class={cn('bs-entity-avatar', className)} title={title || undefined}>
  {#if shouldShowImage && resolvedAvatarUrl}
    <img
      src={resolvedAvatarUrl}
      alt={title ? `${title} avatar` : 'Avatar'}
      class={cn('bs-entity-avatar-image', imageClass)}
      onerror={handleImageError}
    />
  {:else if iconRef}
    <AvatarIconRenderer
      ref={iconRef}
      {customIcons}
      fit={iconFit ?? 'fill'}
      label={title}
      class={cn('bs-entity-avatar-icon', iconClass)}
      {fillIconClass}
    />
  {:else}
    <span class={cn('bs-entity-avatar-initials', initialsClass)}>
      {initials}
    </span>
  {/if}
</span>

<style>
  .bs-entity-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: 9999px;
    background: var(--sidebar-background);
    color: var(--muted-foreground);
  }

  .bs-entity-avatar-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  :global(.bs-entity-avatar-icon) {
    width: 100%;
    height: 100%;
  }

  .bs-entity-avatar-initials {
    color: currentColor;
    font-size: 0.75rem;
    font-weight: 650;
    line-height: 1;
    text-transform: uppercase;
  }
</style>
