import vercel from '@sveltejs/adapter-vercel';
import node from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const vercelSplitFunctions = process.env.BATSHIT_VERCEL_SPLIT === '1';
const adapterName = process.env.BATSHIT_SVELTE_ADAPTER ?? 'vercel';

function resolveAdapter() {
	if (adapterName === 'node') {
		return node({
			out: 'build',
			precompress: true
		});
	}

	return vercel({
		// Adapter now supports nodejs24.x (matches repo engine + Vercel default).
		runtime: 'nodejs24.x',
		// Default to grouped functions because per-route tracing currently
		// exhausts build memory. Flip this on only for targeted experiments.
		split: vercelSplitFunctions,
		external: ['.codex/prompts']
	});
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: resolveAdapter()
	}
};

export default config;
