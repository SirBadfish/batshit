<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from "$lib/utils";
	import type { HTMLTextareaAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();
</script>

<textarea
	bind:this={ref}
	data-slot="textarea"
	class={cn("bs-textarea", className)}
	bind:value
	{...restProps}
></textarea>
