<script lang="ts">
  import { ChevronDown, Loader2, Trash2 } from '@lucide/svelte';
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";

  interface Props {
    open?: boolean;
    sectionClass: string;
    title: string;
    paragraphs: string[];
    error: string | null;
    busy: boolean;
    disabled: boolean;
    onDelete: () => void;
  }

  let {
    open = $bindable(false),
    sectionClass,
    title,
    paragraphs,
    error,
    busy,
    disabled,
    onDelete
  }: Props = $props();
</script>

<Collapsible.Root bind:open>
  <div class={sectionClass}>
    <Collapsible.Trigger class="batshit-settings-delete-trigger">
      <span class="batshit-settings-delete-trigger-label">
        <Trash2 class="batshit-settings-delete-trigger-icon" />
        {title}
      </span>
      <ChevronDown class={`batshit-settings-delete-chevron ${open ? "is-open" : ""}`} />
    </Collapsible.Trigger>
    <Collapsible.Content class="batshit-settings-delete-content">
      <div class="batshit-settings-delete-content-inner">
        <div class="batshit-settings-delete-copy">
          {#each paragraphs as paragraph}
            <p>{paragraph}</p>
          {/each}
          {#if error}
            <p class="batshit-settings-delete-error">
              {error}
            </p>
          {/if}
        </div>
        <Button
          variant="destructive"
          size="sm"
          class="batshit-settings-delete-action"
          onclick={onDelete}
          {disabled}
        >
          {#if busy}
            <Loader2 class="batshit-settings-delete-action-icon is-spinning" />
          {:else}
            <Trash2 class="batshit-settings-delete-action-icon" />
          {/if}
          {title}
        </Button>
      </div>
    </Collapsible.Content>
  </div>
</Collapsible.Root>
