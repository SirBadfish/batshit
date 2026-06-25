<script lang="ts">
	import { enhance } from '$app/forms'
	import type { PageData, ActionData } from './$types'
	import { Button } from '$lib/components/ui/button'
	import { Input } from '$lib/components/ui/input'
	import { Label } from '$lib/components/ui/label'
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card'
	import { Checkbox } from '$lib/components/ui/checkbox'
	import { AlertCircle } from '@lucide/svelte'

	let { data, form }: { data: PageData, form: ActionData } = $props()

	let loading = $state(false)
	let rememberMe = $state(false)
</script>

<div class="flex min-h-screen items-center justify-center bg-background p-4">
	<Card class="w-full max-w-md">
		<CardHeader class="space-y-1">
			<CardTitle class="text-2xl">Welcome to batshit</CardTitle>
			<CardDescription>
				Sign in to your account to continue
			</CardDescription>
		</CardHeader>
		<CardContent>
			<form method="POST" action="?/login" use:enhance={() => {
				loading = true
				return async ({ update }) => {
					loading = false
					await update()
				}
			}}>
				<div class="space-y-4">
					{#if form?.error}
						<div class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
							<AlertCircle class="h-4 w-4" />
							{form.error}
						</div>
					{/if}

					<div class="space-y-2">
						<Label for="email">Email</Label>
						<Input
							id="email"
							name="email"
							type="email"
							placeholder="you@example.com"
							value={form?.email || ''}
							required
							disabled={loading}
						/>
					</div>

					<div class="space-y-2">
						<Label for="password">Password</Label>
						<Input
							id="password"
							name="password"
							type="password"
							required
							disabled={loading}
						/>
					</div>

					<div class="flex items-center space-x-2">
						<Checkbox id="remember" name="remember" bind:checked={rememberMe} class="" />
						<Label for="remember" class="text-sm font-normal cursor-pointer">
							Remember me for 30 days
						</Label>
					</div>

					<Button type="submit" class="w-full" disabled={loading}>
						{loading ? 'Signing in...' : 'Sign in'}
					</Button>
				</div>
			</form>
		</CardContent>
	</Card>
</div>

<style>
	:global(body) {
		overflow: hidden;
	}
</style>