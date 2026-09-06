<script lang="ts" module>
	/**
	 * The gradient and mask are referenced by `url(#id)`, and those ids are
	 * document-global. Two marks on one page (nav plus a footer, say) would both
	 * resolve to the first definition — harmless while they are identical, and a
	 * silent bug the moment one is given a different colour. A per-instance
	 * suffix removes the class of problem rather than betting it never happens.
	 */
	let seq = 0
</script>

<script lang="ts">
	interface Props {
		/** Rendered size in px, square. */
		size?: number
		/** Title for assistive tech; omit for a decorative mark sitting next to the wordmark. */
		label?: string | null
	}

	let { size = 22, label = null }: Props = $props()

	const uid = `cb${(seq += 1)}`
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 256 256"
	fill="none"
	role={label ? 'img' : 'presentation'}
	aria-label={label ?? undefined}
	aria-hidden={label ? undefined : 'true'}
>
	<defs>
		<linearGradient id="{uid}-g" x1="128" y1="39" x2="128" y2="217" gradientUnits="userSpaceOnUse">
			<stop offset="0%" stop-color="#6EE7B7" />
			<stop offset="100%" stop-color="#10B981" />
		</linearGradient>

		<!-- Cores are cut out rather than filled with a background colour, so the
		     mark stays correct on light and dark alike. -->
		<mask id="{uid}-m">
			<rect width="256" height="256" fill="#fff" />
			<circle cx="195.10" cy="92.32" r="10" fill="#000" />
			<circle cx="60.90" cy="163.68" r="10" fill="#000" />
		</mask>
	</defs>

	<g mask="url(#{uid}-m)" stroke-width="26" stroke-linecap="round">
		<!-- Two 136° arcs with the gaps on the diagonal, closing one ring. -->
		<path d="M195.10 92.32 A76 76 0 0 1 104.51 200.28" stroke="url(#{uid}-g)" />
		<path d="M60.90 163.68 A76 76 0 0 1 151.49 55.72" stroke="url(#{uid}-g)" />

		<circle cx="195.10" cy="92.32" r="27" fill="url(#{uid}-g)" />
		<circle cx="60.90" cy="163.68" r="27" fill="url(#{uid}-g)" />
	</g>
</svg>

<style>
	svg {
		display: block;
		flex: none;
	}
</style>
