<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { cn } from "$lib/utils";
  import { Info } from '@lucide/svelte';
  import type { Snippet } from "svelte";

  type Tone = "default" | "amber" | "experimental";

  let {
    ariaLabel = "More information",
    tone = "default",
    align = "start",
    side = "bottom",
    class: className,
    contentClass = "",
    children,
  }: {
    ariaLabel?: string;
    tone?: Tone;
    align?: "start" | "center" | "end";
    side?: "top" | "right" | "bottom" | "left";
    class?: string;
    contentClass?: string;
    children?: Snippet;
  } = $props();

  const triggerClassByTone: Record<Tone, string> = {
    default:
      "batshit-settings-info-trigger inline-flex h-5 w-5 shrink-0 items-center justify-center",
    amber:
      "batshit-settings-info-trigger is-amber inline-flex h-5 w-5 shrink-0 items-center justify-center",
    experimental:
      "batshit-settings-info-trigger is-experimental inline-flex h-5 w-5 shrink-0 items-center justify-center",
  };

  const contentClassByTone: Record<Tone, string> = {
    default:
      "batshit-settings-info-content batshit-settings-card-elevated batshit-settings-card-info-callout z-[var(--z-popover)] w-72",
    amber:
      "batshit-settings-info-content batshit-settings-card-elevated is-amber z-[var(--z-popover)] w-72",
    experimental:
      "batshit-settings-info-content batshit-settings-card-elevated is-experimental z-[var(--z-popover)] w-72",
  };
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={cn(triggerClassByTone[tone], className)}
    aria-label={ariaLabel}
  >
    <Info class="h-3.5 w-3.5" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    {align}
    {side}
    class={cn(contentClassByTone[tone], contentClass)}
  >
    {@render children?.()}
  </DropdownMenu.Content>
</DropdownMenu.Root>
