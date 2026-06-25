<script lang="ts">
  import { Waves } from '@lucide/svelte'
  import AvatarIconRenderer from '$lib/components/icons/AvatarIconRenderer.svelte'
  import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'

  interface MessageModelBadge {
    provider: string
    modelId: string
    modelName: string
    title: string
  }

  interface Props {
    isAI: boolean
    agentDisplayName: string
    agentAvatarUrl: string | null
    agentAvatarIconRef?: any
    agentAvatarIconFit?: any
    userDisplayName: string
    userAvatarUrl: string | null
    userAvatarIconRef?: any
    userAvatarIconFit?: any
    userInitialsSource?: string | null
    timestamp: string
    isSpeaking: boolean
    messageModelBadge: MessageModelBadge | null
  }

  let {
    isAI,
    agentDisplayName,
    agentAvatarUrl,
    agentAvatarIconRef = null,
    agentAvatarIconFit = null,
    userDisplayName,
    userAvatarUrl,
    userAvatarIconRef = null,
    userAvatarIconFit = null,
    userInitialsSource = null,
    timestamp,
    isSpeaking,
    messageModelBadge
  }: Props = $props()

  let failedAgentAvatarUrl = $state<string | null>(null)
  let failedUserAvatarUrl = $state<string | null>(null)

  const resolvedAgentAvatarUrl = $derived(
    typeof agentAvatarUrl === 'string' && agentAvatarUrl.trim().length > 0
      ? agentAvatarUrl.trim()
      : null
  )
  const resolvedUserAvatarUrl = $derived(
    typeof userAvatarUrl === 'string' && userAvatarUrl.trim().length > 0
      ? userAvatarUrl.trim()
      : null
  )
  const showAgentAvatarImage = $derived(
    Boolean(resolvedAgentAvatarUrl && failedAgentAvatarUrl !== resolvedAgentAvatarUrl)
  )
  const showUserAvatarImage = $derived(
    Boolean(resolvedUserAvatarUrl && failedUserAvatarUrl !== resolvedUserAvatarUrl)
  )

  function getInitials(value: string | null | undefined, fallback: string) {
    const source = value?.trim() || fallback
    return source
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  function handleAgentAvatarError() {
    failedAgentAvatarUrl = resolvedAgentAvatarUrl
  }

  function handleUserAvatarError() {
    failedUserAvatarUrl = resolvedUserAvatarUrl
  }
</script>

<div class="message-header {isAI ? 'is-ai' : 'is-user'}">
  {#if isAI}
    <span class="message-avatar message-avatar-agent">
      {#if showAgentAvatarImage && resolvedAgentAvatarUrl}
        <img
          src={resolvedAgentAvatarUrl}
          alt={agentDisplayName}
          class="message-avatar-media"
          onerror={handleAgentAvatarError}
        />
      {:else if agentAvatarIconRef}
        <AvatarIconRenderer
          ref={agentAvatarIconRef}
          fit={agentAvatarIconFit}
          class="message-avatar-media"
          fillIconClass="batshit-avatar-icon-fill"
          label={agentDisplayName}
        />
      {:else}
        <span class="message-avatar-initials">{getInitials(agentDisplayName, 'AI')}</span>
      {/if}
    </span>
    <span class="message-name">
      {agentDisplayName}
    </span>
    {#if isSpeaking}
      <span class="message-speaking-indicator">
        <Waves class="message-speaking-icon" />
        Speaking
      </span>
    {/if}
    <span class="message-meta-hover message-timestamp">
      {timestamp}
    </span>
    {#if messageModelBadge}
      <span class="message-meta-hover message-provider-badge" title={messageModelBadge.title}>
        <ModelProviderIcon
          modelId={messageModelBadge.modelId}
          modelName={messageModelBadge.modelName}
          provider={messageModelBadge.provider}
          size="sm"
        />
      </span>
    {/if}
  {:else}
    <span class="message-meta-hover message-timestamp">
      {timestamp}
    </span>
    <span class="message-name">
      {userDisplayName}
    </span>
    <span class="message-avatar message-avatar-user">
      {#if showUserAvatarImage && resolvedUserAvatarUrl}
        <img
          src={resolvedUserAvatarUrl}
          alt={userDisplayName || 'User'}
          class="message-avatar-media"
          onerror={handleUserAvatarError}
        />
      {:else if userAvatarIconRef}
        <AvatarIconRenderer
          ref={userAvatarIconRef}
          fit={userAvatarIconFit}
          class="message-avatar-media"
          fillIconClass="batshit-avatar-icon-fill"
          label={userDisplayName || 'User'}
        />
      {:else}
        <span class="message-avatar-fallback">
          {getInitials(userInitialsSource, 'User')}
        </span>
      {/if}
    </span>
  {/if}
</div>

<style>
  .message-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    position: relative;
  }

  .message-header.is-user {
    justify-content: flex-end;
  }

  .message-avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 9999px;
  }

  .message-avatar-agent {
    width: 2.25rem;
    height: 2.25rem;
    background: var(--sidebar-background);
    outline: 2px solid oklch(0.11 0.02 272.7 / 0.1);
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.12);
    position: relative;
    left: -10px;
    top: 20px;
    z-index: 1;
    margin-right: -10px;
  }

  :global(.message-avatar-user) {
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    background: var(--sidebar-background);
    outline: 2px solid oklch(0.11 0.02 272.7 / 0.1);
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.12);
    position: relative;
    right: -10px;
    top: 20px;
    z-index: 1;
    margin-left: -10px;
  }

  .message-avatar-media,
  :global(.message-avatar-media) {
    width: 100%;
    height: 100%;
  }

  img.message-avatar-media {
    object-fit: cover;
  }

  .message-avatar-initials,
  .message-avatar-fallback,
  :global(.message-avatar-fallback) {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    background: var(--avatar-background);
    color: var(--avatar-foreground);
    font-size: 0.75rem;
    font-weight: 650;
  }

  :global(.message-avatar-fallback) {
    font-size: 0.875rem;
  }

  .message-name {
    font-size: 0.875rem;
    font-weight: 600;
  }

  .message-speaking-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: oklch(from var(--primary) l c h / 0.8);
    font-size: 0.75rem;
  }

  :global(.message-speaking-icon) {
    width: 0.75rem;
    height: 0.75rem;
  }

  .message-timestamp {
    color: var(--message-timestamp);
    font-size: 0.75rem;
  }

  .message-provider-badge {
    display: inline-flex;
    align-items: center;
  }

  .message-meta-hover {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  }

  :global(.message-row:hover) .message-meta-hover,
  :global(.message-row:focus-within) .message-meta-hover {
    opacity: 1;
    pointer-events: auto;
  }
</style>
