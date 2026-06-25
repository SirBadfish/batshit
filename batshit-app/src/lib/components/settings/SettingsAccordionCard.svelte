<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLDetailsAttributes } from 'svelte/elements'
  import { ChevronDown } from '@lucide/svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import { cn } from '$lib/utils'

  type SettingsAccordionCardProps = HTMLDetailsAttributes & {
    name: string
    title: string
    icon?: any
    batshitIcon?: string | null
    open?: boolean
    collapsible?: boolean
    class?: string
    headerClass?: string
    contentClass?: string
    titleClass?: string
    iconClass?: string
    children?: Snippet
    actions?: Snippet
    info?: Snippet
  }

  let {
    name,
    title,
    icon: Icon,
    batshitIcon = null,
    open = false,
    collapsible = true,
    class: className = '',
    headerClass = '',
    contentClass = '',
    titleClass = '',
    iconClass = '',
    children,
    actions,
    info,
    ...restProps
  }: SettingsAccordionCardProps = $props()
</script>

{#if collapsible}
  <details
    {name}
    {open}
    class={cn('batshit-settings-card batshit-settings-card-default batshit-settings-accordion-card', className)}
    {...restProps}
  >
    <summary class={cn('batshit-settings-accordion-card-header', headerClass)}>
      <span class="batshit-settings-accordion-card-main">
        {#if batshitIcon}
          <span class="batshit-settings-accordion-card-icon">
            <BatshitIcon id={batshitIcon} class={cn('h-4 w-4', iconClass)} />
          </span>
        {:else if Icon}
          <span class="batshit-settings-accordion-card-icon">
            <Icon class={cn('h-4 w-4', iconClass)} />
          </span>
        {/if}
        <span class={cn('batshit-settings-accordion-card-title', titleClass)}>
          {title}
        </span>
        {#if info}
          <span
            class="batshit-settings-accordion-card-info"
            role="presentation"
            onclick={(event) => event.stopPropagation()}
            onkeydown={(event) => event.stopPropagation()}
          >
            {@render info()}
          </span>
        {/if}
      </span>

      <span class="batshit-settings-accordion-card-side">
        {#if actions}
          <span
            class="batshit-settings-accordion-card-actions"
            role="presentation"
            onclick={(event) => event.stopPropagation()}
            onkeydown={(event) => event.stopPropagation()}
          >
            {@render actions()}
          </span>
        {/if}
        <ChevronDown class="batshit-settings-accordion-card-chevron h-4 w-4" />
      </span>
    </summary>

    <div class={cn('batshit-settings-accordion-card-content', contentClass)}>
      {@render children?.()}
    </div>
  </details>
{:else}
  <section
    class={cn('batshit-settings-card batshit-settings-card-default batshit-settings-accordion-card is-static', className)}
  >
    <div class={cn('batshit-settings-accordion-card-header', headerClass)}>
      <span class="batshit-settings-accordion-card-main">
        {#if batshitIcon}
          <span class="batshit-settings-accordion-card-icon">
            <BatshitIcon id={batshitIcon} class={cn('h-4 w-4', iconClass)} />
          </span>
        {:else if Icon}
          <span class="batshit-settings-accordion-card-icon">
            <Icon class={cn('h-4 w-4', iconClass)} />
          </span>
        {/if}
        <span class={cn('batshit-settings-accordion-card-title', titleClass)}>
          {title}
        </span>
        {#if info}
          <span
            class="batshit-settings-accordion-card-info"
            role="presentation"
            onclick={(event) => event.stopPropagation()}
            onkeydown={(event) => event.stopPropagation()}
          >
            {@render info()}
          </span>
        {/if}
      </span>

      {#if actions}
        <span class="batshit-settings-accordion-card-side">
          <span
            class="batshit-settings-accordion-card-actions"
            role="presentation"
            onclick={(event) => event.stopPropagation()}
            onkeydown={(event) => event.stopPropagation()}
          >
            {@render actions()}
          </span>
        </span>
      {/if}
    </div>

    <div class={cn('batshit-settings-accordion-card-content', contentClass)}>
      {@render children?.()}
    </div>
  </section>
{/if}
