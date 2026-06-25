<script lang="ts">
  import AvatarIconRenderer from '$lib/components/icons/AvatarIconRenderer.svelte'
  import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'

  interface Props {
    avatarUrl: string | null
    avatarLabel: string
    iconRef?: IconRef | null
    iconFit?: AvatarIconFit | null
    fallback: string
  }

  let { avatarUrl, avatarLabel, iconRef = null, iconFit = 'contain', fallback }: Props = $props()
  let failedAvatarUrl = $state<string | null>(null)

  const resolvedAvatarUrl = $derived(
    typeof avatarUrl === 'string' && avatarUrl.trim().length > 0 ? avatarUrl.trim() : null
  )
  const shouldShowImage = $derived(Boolean(resolvedAvatarUrl && failedAvatarUrl !== resolvedAvatarUrl))

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

<span class="session-item-avatar">
  {#if shouldShowImage && resolvedAvatarUrl}
    <img
      src={resolvedAvatarUrl}
      alt={`${avatarLabel} avatar`}
      class="session-item-avatar-img"
      onerror={handleImageError}
    />
  {:else if iconRef}
    <AvatarIconRenderer
      ref={iconRef}
      fit={iconFit ?? 'fill'}
      class="session-item-avatar-icon"
      label={avatarLabel}
    />
  {:else}
    <span class="session-item-avatar-initials">
      {getInitials(avatarLabel, fallback)}
    </span>
  {/if}
</span>

<style>
  .session-item-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    overflow: hidden;
    border: 1px solid var(--sidebar-border);
    border-radius: 999px;
    background: var(--sidebar-background);
  }

  .session-item-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  :global(.session-item-avatar-icon) {
    width: 100%;
    height: 100%;
  }

  .session-item-avatar-initials {
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
</style>
