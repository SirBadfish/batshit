<script lang="ts" module>
	import { cn, type WithElementRef } from "$lib/utils";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
	import { type VariantProps, tv } from "tailwind-variants";

	export const buttonVariants = tv({
		base: "bs-button",
		variants: {
			variant: {
				default: "bs-button-default",
				destructive: "bs-button-destructive",
				outline: "bs-button-outline",
				secondary: "bs-button-secondary",
				ghost: "bs-button-ghost",
				link: "bs-button-link",
			},
			size: {
				default: "bs-button-size-default",
				xs: "bs-button-size-xs",
				sm: "bs-button-size-sm",
				lg: "bs-button-size-lg",
				icon: "bs-button-size-icon",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	function getSemanticButtonClasses(variant: ButtonVariant = "default", size: ButtonSize = "default") {
		const semanticSize = size === "xs" ? "small" : size === "sm" || size === "icon" ? "medium" : "large";
		const semanticIntent =
			variant === "default"
				? "primary"
				: variant === "destructive"
					? "danger"
					: variant === "link"
						? "link"
						: "secondary";

		return cn(
			"batshit-button",
			`batshit-button-${semanticSize}`,
			`batshit-button-${semanticSize}-${semanticIntent}`,
			size === "icon" && `batshit-button-${semanticSize}-icon`
		);
	}

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(getSemanticButtonClasses(variant, size), buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(getSemanticButtonClasses(variant, size), buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
