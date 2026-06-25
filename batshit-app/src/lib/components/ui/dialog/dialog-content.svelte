<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import XIcon from "@lucide/svelte/icons/x";
	import type { Snippet } from "svelte";
	import * as Dialog from "./index.js";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils";

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		showCloseButton = true,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		portalProps?: DialogPrimitive.PortalProps;
		children: Snippet;
		showCloseButton?: boolean;
	} = $props();
</script>

<Dialog.Portal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			"bs-dialog-content data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 gap-4 duration-200",
			className
	)}
	{...restProps}
>
	{#if showCloseButton}
		<div class="bs-dialog-close-row">
			<DialogPrimitive.Close
				data-slot="dialog-close"
				class="bs-dialog-close"
			>
				<XIcon class="h-5 w-5" />
				<span class="sr-only">Close</span>
			</DialogPrimitive.Close>
		</div>
	{/if}
	{@render children?.()}
</DialogPrimitive.Content>
</Dialog.Portal>
