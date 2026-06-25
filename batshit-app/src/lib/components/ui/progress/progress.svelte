<script lang="ts">
  import { cn } from '$lib/utils.js'
  
  let {
    value = 0,
    max = 100,
    class: className,
    ...restProps
  } = $props<{
    value?: number
    max?: number
    class?: string
    [key: string]: any
  }>()
  
  const percentage = $derived(Math.min(Math.max(0, (value ?? 0) / (max ?? 100)), 1) * 100)
</script>

<div
  role="progressbar"
  aria-valuemin={0}
  aria-valuemax={max}
  aria-valuenow={value}
  class={cn('bs-progress', className)}
  {...restProps}
>
  <div
    class="bs-progress-bar"
    style="transform: translateX(-{100 - percentage}%)"
  ></div>
</div>
