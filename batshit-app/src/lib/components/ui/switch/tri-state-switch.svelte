<script lang="ts">
	/**
	 * Tri-State Switch Component (Regular Size)
	 * A full-size toggle switch that displays three states:
	 * - Off (unchecked): No items selected
	 * - On (checked): All items selected
	 * - Partial (indeterminate): Some items selected
	 *
	 * Visually shows partial state with a dash indicator in the thumb
	 */
	import { Switch as SwitchPrimitive } from "bits-ui";
	import { Minus } from '@lucide/svelte';
	import { cn, type WithoutChildrenOrChild } from "$lib/utils";

	interface Props extends WithoutChildrenOrChild<SwitchPrimitive.RootProps> {
		selectedCount: number;
		totalCount: number;
		onToggle?: (state: 'checked' | 'unchecked' | 'indeterminate') => void;
		ref?: HTMLButtonElement | null;
		class?: string;
	}

	let {
		selectedCount,
		totalCount,
		onToggle,
		ref = $bindable(null),
		class: className,
		...restProps
	}: Props = $props();

	// Compute switch state
	let switchState = $derived.by((): 'checked' | 'unchecked' | 'indeterminate' => {
		if (selectedCount === 0) return 'unchecked';
		if (selectedCount === totalCount) return 'checked';
		return 'indeterminate';
	});

	let checked = $derived(switchState === 'checked');
	let isIndeterminate = $derived(switchState === 'indeterminate');

	// Handle click - cycle through states
	function handleClick() {
		onToggle?.(switchState);
	}
</script>

<button
	type="button"
	onclick={handleClick}
	bind:this={ref}
	data-slot="tri-state-switch"
	data-state={checked || isIndeterminate ? 'checked' : 'unchecked'}
	class={cn("bs-switch peer", className)}
	{...restProps}
>
	<div
		class="bs-switch-thumb is-centered"
	>
		{#if isIndeterminate}
			<Minus class="size-3 text-primary dark:text-primary" />
		{/if}
	</div>
</button>
