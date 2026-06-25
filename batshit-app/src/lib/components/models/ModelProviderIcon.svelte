<script lang="ts">
	import {
		getModelProviderIcons,
		getProviderBackground,
		getProviderIconEntry,
		needsDarkModeInvert
	} from '$lib/utils/brandingIcons';
	import { themeStore } from '$lib/stores/theme';
	
	interface Props {
		modelId: string;
		modelName?: string;
		provider: string;
		size?: 'sm' | 'md' | 'lg';
		showOverlay?: boolean;
		customIconPath?: string;
		badgeProvider?: string | null;
	}
	
	let { 
		modelId, 
		modelName,
		provider, 
		size = 'md',
		showOverlay = true,
		customIconPath,
		badgeProvider = null
	}: Props = $props();
	
	// Get icon configuration
	const iconConfig = $derived(
		getModelProviderIcons(
			modelId,
			provider,
			customIconPath,
			modelName,
			$themeStore,
			badgeProvider ?? null
		)
	);
	
	// Size classes
	const sizeClasses = {
		sm: 'h-4 w-4',
		md: 'h-6 w-6',
		lg: 'h-8 w-8'
	};
	
	// Inner icon size classes (with padding)
	const innerSizeClasses = {
		sm: 'h-3 w-3',
		md: 'h-4 w-4',
		lg: 'h-6 w-6'
	};
	
	const overlaySizeClasses = {
		sm: 'h-2.5 w-2.5',
		md: 'h-3.5 w-3.5',
		lg: 'h-4.5 w-4.5'
	};
	
	const fontSizeClasses = {
		sm: 'text-[8px]',
		md: 'text-[10px]',
		lg: 'text-xs'
	};
	
	// Badge provider handling
	const overlayProvider = $derived(badgeProvider ?? provider);
	const overlayEntry = $derived(getProviderIconEntry(overlayProvider, $themeStore));
	const overlayBackground = $derived(getProviderBackground(overlayProvider));
	const overlayNeedsBackground = $derived(!!overlayBackground);

	let modelFilter = $state<string | null>(null);
	$effect(() => {
		const invertModel = needsDarkModeInvert(iconConfig.modelIcon);
		modelFilter = invertModel && $themeStore === 'dark' ? 'brightness(0) invert(1)' : null;
	});

	let overlayFilter = $state<string | null>(null);
	$effect(() => {
		const invertOverlay = needsDarkModeInvert(overlayEntry.icon);
		overlayFilter = invertOverlay && $themeStore === 'dark' ? 'brightness(0) invert(1)' : null;
	});

	// Check if model has its own icon (different from provider)
	const hasModelSpecificIcon = $derived(iconConfig.modelIcon !== iconConfig.providerIcon);
	
	// Always show provider overlay when requested (even if icons are the same)
	const showProviderOverlay = $derived(showOverlay);
	
	// Get model initials for fallback
	const getModelInitials = (name: string) => {
		// Handle special cases
		if (name.toLowerCase().includes('gpt-4o')) return '4o';
		if (name.toLowerCase().includes('gpt-4')) return '4';
		if (name.toLowerCase().includes('gpt-3.5')) return '3.5';
		
		// Otherwise take first letters of words
		const words = name.split(/[-_\s]/);
		if (words.length >= 2) {
			return words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
		}
		return name.slice(0, 2).toUpperCase();
	};
</script>

<div class="relative inline-flex items-center justify-center {sizeClasses[size]}">
	<!-- Container for main icon with padding -->
	<div class="relative w-full h-full flex items-center justify-center">
		{#if iconConfig.needsBackground && !hasModelSpecificIcon}
			<!-- Optional backing plate for provider assets that require one. -->
			<div 
				class="absolute inset-0 rounded-full"
				style="background-color: {iconConfig.backgroundColor}"
			></div>
		{/if}
		
		<!-- Main icon (model if available, otherwise provider) with padding -->
		<div class="{innerSizeClasses[size]} relative z-5">
			<img 
				src={iconConfig.modelIcon} 
				alt={modelName || modelId}
				class="w-full h-full rounded-full object-contain"
				style:filter={modelFilter || null}
			/>
		</div>
	</div>
	
	<!-- Provider overlay badge (bottom-right corner) - always show when overlay is enabled -->
	{#if showProviderOverlay}
		<div class="absolute -bottom-1 -right-1 {overlaySizeClasses[size]} rounded-full bg-background border border-border flex items-center justify-center z-6">
			{#if overlayNeedsBackground}
				<!-- Optional backing plate for provider assets that require one. -->
				<div
					class="absolute inset-0 rounded-full"
					style="background-color: {overlayBackground}"
				></div>
			{/if}
			<div class="w-full h-full p-0.5">
				<img
					src={overlayEntry.icon}
					alt={overlayProvider}
					class="w-full h-full object-contain relative z-5"
					style:filter={overlayFilter || null}
				/>
			</div>
		</div>
	{/if}
</div>
