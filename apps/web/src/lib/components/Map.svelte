<script lang="ts">
	import { onMount } from 'svelte'
	import EmptyState from './EmptyState.svelte'

	interface Props {
		/** Route as [lon, lat] pairs, already filtered of null coordinates. */
		path?: [number, number][]
		/** A single point of interest — last known position, or a charge site. */
		marker?: { lat: number; lon: number } | null
		/** Drawn as a small ring at the start of a route. */
		startMarker?: { lat: number; lon: number } | null
		height?: string
		/** A garage card wants a locator, not a toy: panning it is a misclick. */
		interactive?: boolean
		emptyTitle?: string
		emptyDetail?: string
	}

	let {
		path = [],
		marker = null,
		startMarker = null,
		height = '320px',
		interactive = true,
		emptyTitle = 'No location recorded',
		emptyDetail =
			'vehicle_location is a separate permission, and the car did not report coordinates for this period. Everything else on this page is still accurate.'
	}: Props = $props()

	let container = $state<HTMLDivElement | null>(null)
	let failed = $state(false)

	// A map with nothing to show is not an error and must not be a blank grey
	// box either: a drive recorded without the location scope is a VALID drive.
	let hasGeometry = $derived(path.length > 0 || marker != null || startMarker != null)

	onMount(() => {
		if (!hasGeometry || !container) return

		let map: { remove: () => void } | null = null
		let cancelled = false

		// maplibre-gl touches `window` at module scope, so it can only be pulled
		// in here. A static import crashes server-side rendering of every page
		// that mounts a map — which, on this site, is most of them.
		;(async () => {
			try {
				// The namespace, not the default export: maplibre-gl's types declare
				// only named exports, and destructuring `default` off it fails
				// typechecking even though the runtime bundle happens to have one.
				const [maplibregl] = await Promise.all([
					import('maplibre-gl'),
					import('maplibre-gl/dist/maplibre-gl.css')
				])
				if (cancelled || !container) return

				const bounds = geometryBounds()
				const instance = new maplibregl.Map({
					container,
					// An inline style spec rather than a hosted style URL: this app is
					// self-hosted and must not need a third-party API key to draw a map.
					style: {
						version: 8,
						sources: {
							osm: {
								type: 'raster',
								tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
								tileSize: 256,
								maxzoom: 19,
								attribution: '&copy; OpenStreetMap contributors'
							}
						},
						layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
					},
					center: [bounds.centerLon, bounds.centerLat],
					zoom: 13,
					interactive,
					attributionControl: { compact: true }
				})
				map = instance

				instance.on('load', () => {
					if (cancelled) return
					if (path.length > 1) {
						instance.addSource('route', {
							type: 'geojson',
							data: {
								type: 'Feature',
								properties: {},
								geometry: { type: 'LineString', coordinates: path }
							}
						})
						// Two stacked lines: a wide translucent casing under a bright
						// core, so the route stays readable over both dark tarmac and
						// pale fields without tinting the basemap.
						instance.addLayer({
							id: 'route-casing',
							type: 'line',
							source: 'route',
							layout: { 'line-cap': 'round', 'line-join': 'round' },
							paint: { 'line-color': '#0b0e12', 'line-opacity': 0.35, 'line-width': 7 }
						})
						instance.addLayer({
							id: 'route-line',
							type: 'line',
							source: 'route',
							layout: { 'line-cap': 'round', 'line-join': 'round' },
							paint: { 'line-color': '#2f9df4', 'line-width': 3.5 }
						})
					}

					const first = startMarker ?? (path.length > 0 ? { lon: path[0]![0], lat: path[0]![1] } : null)
					if (first) addDot(maplibregl, instance, first, 'start')
					const last =
						marker ??
						(path.length > 1
							? { lon: path[path.length - 1]![0], lat: path[path.length - 1]![1] }
							: null)
					if (last) addDot(maplibregl, instance, last, 'end')

					if (path.length > 1) {
						instance.fitBounds(
							[
								[bounds.minLon, bounds.minLat],
								[bounds.maxLon, bounds.maxLat]
							],
							{ padding: 48, duration: 0, maxZoom: 15 }
						)
					}
				})
			} catch {
				// Offline, blocked tiles, or a WebGL-less browser. The page keeps
				// every number it was going to show; only the map is missing.
				if (!cancelled) failed = true
			}
		})()

		return () => {
			cancelled = true
			map?.remove()
		}
	})

	function addDot(
		maplibregl: typeof import('maplibre-gl'),
		instance: import('maplibre-gl').Map,
		at: { lat: number; lon: number },
		kind: 'start' | 'end'
	) {
		const el = document.createElement('div')
		el.className = `map-dot ${kind}`
		new maplibregl.Marker({ element: el }).setLngLat([at.lon, at.lat]).addTo(instance)
	}

	function geometryBounds() {
		const lons: number[] = path.map((p) => p[0])
		const lats: number[] = path.map((p) => p[1])
		for (const m of [marker, startMarker]) {
			if (m) {
				lons.push(m.lon)
				lats.push(m.lat)
			}
		}
		// hasGeometry gates the caller, so these arrays are never empty here.
		const minLon = Math.min(...lons)
		const maxLon = Math.max(...lons)
		const minLat = Math.min(...lats)
		const maxLat = Math.max(...lats)
		return {
			minLon,
			maxLon,
			minLat,
			maxLat,
			centerLon: (minLon + maxLon) / 2,
			centerLat: (minLat + maxLat) / 2
		}
	}
</script>

{#if !hasGeometry}
	<EmptyState title={emptyTitle} detail={emptyDetail} icon="⌖" />
{:else if failed}
	<EmptyState
		title="Map unavailable"
		detail="The map tiles could not be loaded. The coordinates were recorded and are unaffected."
		icon="⌖"
	/>
{:else}
	<div class="map" bind:this={container} style="height: {height}"></div>
{/if}

<style>
	.map {
		width: 100%;
		border-radius: var(--radius);
		overflow: hidden;
		border: 1px solid var(--border);
		background: var(--surface-inset);
	}

	/* Marker elements are created imperatively by MapLibre outside this
	   component's scope, so their styles have to be global. */
	:global(.map-dot) {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2.5px solid #ffffff;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
	}

	:global(.map-dot.start) {
		background: #ffffff;
		border-color: #2f9df4;
	}

	:global(.map-dot.end) {
		background: #2f9df4;
	}

	/* The default attribution chrome is white-on-white in dark mode. */
	:global(.maplibregl-ctrl-attrib) {
		font-size: 10px;
	}
</style>
