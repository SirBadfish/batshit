<script>
  import { Checkbox } from 'bits-ui';
  import { Check } from '@lucide/svelte';
  import { cn } from '$lib/utils';

  let {
    checked = $bindable(false),
    disabled = false,
    class: className,
    ...restProps
  } = $props();
</script>

<Checkbox.Root
  bind:checked
  {disabled}
  class={cn('bs-checkbox peer', className)}
  {...restProps}
>
  <div class={cn('flex items-center justify-center text-current')}>
    {#if checked}
      <Check class="h-3 w-3" />
    {/if}
  </div>
</Checkbox.Root>
