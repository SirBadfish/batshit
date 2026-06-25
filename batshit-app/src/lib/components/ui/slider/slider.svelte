<script lang="ts">
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn } from "$lib/utils";

	let { 
		class: className = undefined,
		value = $bindable(),
		onValueChange = undefined,
		disabled = undefined,
		min = 0,
		max = 100,
		step = 1,
		type = "single" as "single" | "multiple",
		fillFrom = undefined as number | undefined,
		showAnchorMarker = false,
		thumbShape = "round" as "round" | "bar",
		...restProps
	} = $props();

	function clampToRange(nextValue: number): number {
		return Math.min(max, Math.max(min, nextValue));
	}

	function toPercent(nextValue: number): number {
		if (max === min) return 0;
		return ((clampToRange(nextValue) - min) / (max - min)) * 100;
	}

	const sliderValue = $derived.by(() => {
		if (Array.isArray(value)) return value[0] ?? min;
		return typeof value === "number" ? value : min;
	});
	const anchorValue = $derived.by(() => clampToRange(fillFrom ?? min));
	const anchorPercent = $derived.by(() => toPercent(anchorValue));
	const valuePercent = $derived.by(() => toPercent(sliderValue));
	const fillStartPercent = $derived.by(() => Math.min(anchorPercent, valuePercent));
	const fillWidthPercent = $derived.by(() => Math.abs(valuePercent - anchorPercent));
</script>

<SliderPrimitive.Root
	bind:value
	{onValueChange}
	{disabled}
	{min}
	{max}
	{step}
	{type}
	class={cn(
		"bs-slider-root",
		showAnchorMarker && "has-anchor",
		className
	)}
	{...restProps}
>
	<span
		class="bs-slider-track"
	>
		<span
			class="bs-slider-range"
			style={`left: ${fillStartPercent}%; width: ${fillWidthPercent}%;`}
		></span>
		{#if showAnchorMarker}
			<span
				class="bs-slider-anchor"
				style={`left: calc(${anchorPercent}% - 0.5px);`}
			></span>
		{/if}
	</span>
	<SliderPrimitive.Thumb
	index={0}
	class={cn(
		"bs-slider-thumb",
		thumbShape === "bar" ? "is-bar" : "is-round"
	)}
/>
</SliderPrimitive.Root>
