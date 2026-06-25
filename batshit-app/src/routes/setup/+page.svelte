<script lang="ts">
	import { enhance } from '$app/forms'
	import type { ActionData } from './$types'
	import { Button } from '$lib/components/ui/button'
	import { Input } from '$lib/components/ui/input'
	import { Label } from '$lib/components/ui/label'
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card'
	import { AlertCircle } from '@lucide/svelte'

	let { form }: { form: ActionData } = $props()

	let loading = $state(false)
	let password = $state('')
	let confirmPassword = $state('')

	let passwordsMatch = $derived(password === confirmPassword && password.length > 0)
	let passwordError = $derived(confirmPassword.length > 0 && !passwordsMatch)
</script>

<div class="flex min-h-screen items-center justify-center bg-background p-4">
	<Card class="w-full max-w-md">
		<CardHeader class="space-y-1">
			<CardTitle class="text-2xl">Welcome to batshit!</CardTitle>
			<CardDescription>
				Create your admin account to get started
			</CardDescription>
		</CardHeader>
		<CardContent>
			<form method="POST" action="?/setup" use:enhance={() => {
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
							placeholder="admin@example.com"
							value={form?.email || ''}
							required
							disabled={loading}
						/>
					</div>

					<div class="space-y-2">
						<Label for="displayName">Display Name</Label>
						<Input
							id="displayName"
							name="displayName"
							type="text"
							placeholder="Your Name"
							value={form?.displayName || ''}
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
							bind:value={password}
							required
							disabled={loading}
						/>
						<p class="text-xs text-muted-foreground">
							Must be at least 10 characters
						</p>
					</div>

					<div class="space-y-2">
						<Label for="confirmPassword">Confirm Password</Label>
						<Input
							id="confirmPassword"
							name="confirmPassword"
							type="password"
							bind:value={confirmPassword}
							class={passwordError ? 'border-destructive' : ''}
							required
							disabled={loading}
						/>
						{#if passwordError}
							<p class="text-xs text-destructive">
								Passwords do not match
							</p>
						{/if}
					</div>

					<Button 
						type="submit" 
						class="w-full" 
						disabled={loading || (confirmPassword.length > 0 && !passwordsMatch)}
					>
						{loading ? 'Creating account...' : 'Create Admin Account'}
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