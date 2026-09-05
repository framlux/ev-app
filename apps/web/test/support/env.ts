/**
 * Stands in for SvelteKit's `$env/dynamic/private` when a server module is
 * imported by a test.
 *
 * vitest runs these files outside a SvelteKit runtime, so `$env/dynamic/private`
 * resolves to nothing and any module reading configuration is unimportable —
 * which is why `auth.ts` has no test today. vitest.config.ts aliases the
 * specifier here instead, so the module under test keeps reading the
 * environment exactly the way it does in the pod.
 *
 * The PUBLIC_ filter is not decoration. SvelteKit reserves that prefix for
 * values it exposes to the browser and strips them from the private
 * environment; a server variable named PUBLIC_x is therefore unreadable however
 * carefully the deployment sets it. That shipped once as PUBLIC_ORIGIN and made
 * every sign-in a 500 while the ConfigMap looked right (see env-names.test.ts).
 * A stub without the filter would let exactly that bug pass a test.
 */
export const env: Record<string, string | undefined> = new Proxy(process.env, {
	get: (target, key) =>
		typeof key === 'string' && key.startsWith('PUBLIC_') ? undefined : target[key as string]
}) as Record<string, string | undefined>
