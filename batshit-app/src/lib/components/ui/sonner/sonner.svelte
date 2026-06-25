<script module lang="ts">
	import { toast } from 'svelte-sonner';
	import { scopeToastOptions } from './toast-scope';

	const PERSISTENT_ERROR_TOAST_DURATION = Number.POSITIVE_INFINITY;
	const SCOPED_TOAST_PATCH_FLAG = '__batshitScopedToastsPatched';
	const toastRecord = toast as unknown as Record<string, unknown>;

	if (!toastRecord[SCOPED_TOAST_PATCH_FLAG]) {
		const originalSuccess = toast.success.bind(toast);
		const originalInfo = toast.info.bind(toast);
		const originalWarning = toast.warning.bind(toast);
		const originalError = toast.error.bind(toast);
		const originalCustom = toast.custom.bind(toast);
		const originalMessage = toast.message.bind(toast);
		const originalPromise = toast.promise.bind(toast);
		const originalLoading = toast.loading.bind(toast);

		toast.success = ((
			message: Parameters<typeof originalSuccess>[0],
			data?: Parameters<typeof originalSuccess>[1]
		) => originalSuccess(message, scopeToastOptions(data, 'app'))) as typeof toast.success;
		toast.info = ((
			message: Parameters<typeof originalInfo>[0],
			data?: Parameters<typeof originalInfo>[1]
		) => originalInfo(message, scopeToastOptions(data, 'app'))) as typeof toast.info;
		toast.warning = ((
			message: Parameters<typeof originalWarning>[0],
			data?: Parameters<typeof originalWarning>[1]
		) => originalWarning(message, scopeToastOptions(data, 'app'))) as typeof toast.warning;
		toast.error = ((message: Parameters<typeof originalError>[0], data?: Parameters<typeof originalError>[1]) =>
			originalError(message, {
				closeButton: true,
				duration: PERSISTENT_ERROR_TOAST_DURATION,
				...scopeToastOptions(data, 'app')
			})) as typeof toast.error;
		toast.custom = ((
			component: Parameters<typeof originalCustom>[0],
			data?: Parameters<typeof originalCustom>[1]
		) => originalCustom(component, scopeToastOptions(data, 'app'))) as typeof toast.custom;
		toast.message = ((
			message: Parameters<typeof originalMessage>[0],
			data?: Parameters<typeof originalMessage>[1]
		) => originalMessage(message, scopeToastOptions(data, 'app'))) as typeof toast.message;
		toast.promise = ((
			promise: Parameters<typeof originalPromise>[0],
			data?: Parameters<typeof originalPromise>[1]
		) => originalPromise(promise, scopeToastOptions(data, 'app'))) as typeof toast.promise;
		toast.loading = ((
			message: Parameters<typeof originalLoading>[0],
			data?: Parameters<typeof originalLoading>[1]
		) => originalLoading(message, scopeToastOptions(data, 'app'))) as typeof toast.loading;
		toastRecord[SCOPED_TOAST_PATCH_FLAG] = true;
	}
</script>

<script lang="ts">
	import { Toaster as Sonner } from 'svelte-sonner';

	let {
		...restProps
	} = $props();
</script>

<Sonner 
	theme="dark"
	class="toaster group"
	{...restProps}
	toastOptions={{
		classes: {
			toast:
				'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
			description: 'group-[.toast]:text-muted-foreground',
			actionButton:
				'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
			cancelButton:
				'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
			success: 'group-[.toaster]:bg-background group-[.toaster]:text-foreground batshit-toast-success',
			error: 'group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-destructive',
		},
	}}
	{...restProps}
/>
