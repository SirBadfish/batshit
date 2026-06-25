import { toast as baseToast } from 'svelte-sonner';
import { scopeToastOptions } from './toast-scope';

const toast = Object.assign(
	((message: Parameters<typeof baseToast>[0], data?: Parameters<typeof baseToast>[1]) =>
		baseToast(message, scopeToastOptions(data, 'settings'))) as typeof baseToast,
	{
		success: ((
			message: Parameters<typeof baseToast.success>[0],
			data?: Parameters<typeof baseToast.success>[1]
		) => baseToast.success(message, scopeToastOptions(data, 'settings'))) as typeof baseToast.success,
		info: ((
			message: Parameters<typeof baseToast.info>[0],
			data?: Parameters<typeof baseToast.info>[1]
		) => baseToast.info(message, scopeToastOptions(data, 'settings'))) as typeof baseToast.info,
		warning: ((
			message: Parameters<typeof baseToast.warning>[0],
			data?: Parameters<typeof baseToast.warning>[1]
		) => baseToast.warning(message, scopeToastOptions(data, 'settings'))) as typeof baseToast.warning,
		error: ((
			message: Parameters<typeof baseToast.error>[0],
			data?: Parameters<typeof baseToast.error>[1]
		) => baseToast.error(message, scopeToastOptions(data, 'settings'))) as typeof baseToast.error,
		custom: ((
			component: Parameters<typeof baseToast.custom>[0],
			data?: Parameters<typeof baseToast.custom>[1]
		) => baseToast.custom(component, scopeToastOptions(data, 'settings'))) as typeof baseToast.custom,
		message: ((
			message: Parameters<typeof baseToast.message>[0],
			data?: Parameters<typeof baseToast.message>[1]
		) => baseToast.message(message, scopeToastOptions(data, 'settings'))) as typeof baseToast.message,
		promise: ((
			promise: Parameters<typeof baseToast.promise>[0],
			data?: Parameters<typeof baseToast.promise>[1]
		) => baseToast.promise(promise, scopeToastOptions(data, 'settings'))) as typeof baseToast.promise,
		loading: ((
			message: Parameters<typeof baseToast.loading>[0],
			data?: Parameters<typeof baseToast.loading>[1]
		) => baseToast.loading(message, scopeToastOptions(data, 'settings'))) as typeof baseToast.loading,
		dismiss: baseToast.dismiss.bind(baseToast),
		getActiveToasts: baseToast.getActiveToasts.bind(baseToast)
	}
);

export { toast };
