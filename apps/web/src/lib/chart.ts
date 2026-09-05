/**
 * Pure chart geometry: extents, scales, SVG paths, ticks, decimation.
 *
 * Every chart on this site is inline SVG with no charting library, so this
 * module is where the arithmetic lives — and, more importantly, where the
 * degenerate cases live. The database is empty on day one and stays sparse for
 * a while, so the inputs a chart actually gets first are: zero points, one
 * point, and a series whose values are all identical. Each of those divides by
 * a zero span if written naively, and `NaN` in an SVG `d` attribute renders as
 * nothing at all with no error anywhere — a blank rectangle that looks like a
 * styling bug rather than a missing-data bug.
 *
 * So: every function here is total. Nothing throws, nothing returns NaN, and
 * "there is no chart to draw" is expressed as `null`, which callers render as
 * an empty state instead of an axis around thin air.
 */

export interface Point {
  x: number
  y: number
  /** Carried through so a mark can dim itself by confidence, keep a label, etc. */
  meta?: unknown
}

export interface Extent {
  min: number
  max: number
}

/**
 * Min/max of the finite values, or null when there are none.
 *
 * Nulls are skipped rather than treated as 0: a SoC series with a gap must not
 * dive to the floor and back for every missing reading.
 */
export function extent(values: readonly (number | null | undefined)[]): Extent | null {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  return min === Infinity ? null : { min, max }
}

/**
 * Widen an extent so marks are not welded to the frame, and — the case that
 * matters — give a zero-span extent a real span.
 *
 * A single sample, or an hour of a parked car reporting the same 62%, produces
 * min === max. Scaling that spans zero, which is a division by zero; the pad
 * here is what keeps a flat line drawn horizontally through the middle of the
 * plot instead of disappearing.
 */
export function padExtent(e: Extent, fraction = 0.08): Extent {
  const span = e.max - e.min
  if (span === 0) {
    const bump = Math.abs(e.min) > 0 ? Math.abs(e.min) * 0.05 : 1
    return { min: e.min - bump, max: e.max + bump }
  }
  const pad = span * fraction
  return { min: e.min - pad, max: e.max + pad }
}

/**
 * A linear scale from a data domain to a pixel range.
 *
 * The zero-span guard returns the midpoint of the range rather than Infinity.
 * Callers are expected to have padded first; this is the belt to that braces,
 * because one unpadded scale is enough to blank a chart.
 */
export function scaleLinear(domain: Extent, range: [number, number]): (v: number) => number {
  const span = domain.max - domain.min
  const [r0, r1] = range
  if (span === 0) {
    const mid = (r0 + r1) / 2
    return () => mid
  }
  return (v: number) => r0 + ((v - domain.min) / span) * (r1 - r0)
}

/**
 * Turn rows into plottable points, dropping any row whose x or y is missing.
 *
 * `y == null` and not `!y`: a charging power of exactly 0 kW at the end of a
 * charge is a real, meaningful reading, and a truthiness filter would delete
 * precisely the part of the curve that shows the taper finishing.
 */
export function toPoints<T>(
  rows: readonly T[],
  x: (row: T) => number | null | undefined,
  y: (row: T) => number | null | undefined,
  meta?: (row: T) => unknown,
): Point[] {
  const out: Point[] = []
  for (const row of rows) {
    const xv = x(row)
    const yv = y(row)
    if (xv == null || yv == null) continue
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue
    out.push(meta ? { x: xv, y: yv, meta: meta(row) } : { x: xv, y: yv })
  }
  return out
}

/**
 * An SVG polyline `d` for already-projected points. Empty string for an empty
 * series, so the attribute is present but draws nothing — never `undefined`,
 * which some browsers log about, and never `NaN`.
 */
export function linePath(points: readonly Point[]): string {
  if (points.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    parts.push(`${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
  }
  return parts.join(' ')
}

/**
 * The same line closed down to a baseline, for the soft fill under a series.
 * A single point has no area to fill, so it yields '' rather than a degenerate
 * triangle.
 */
export function areaPath(points: readonly Point[], baselineY: number): string {
  if (points.length < 2) return ''
  const first = points[0]!
  const last = points[points.length - 1]!
  return `${linePath(points)} L${round(last.x)} ${round(baselineY)} L${round(first.x)} ${round(baselineY)} Z`
}

function round(n: number): number {
  // Two decimals is well under a device pixel and keeps the markup readable.
  return Math.round(n * 100) / 100
}

/**
 * Human tick values covering [min, max] at roughly `count` intervals.
 *
 * Every tick returned lies inside the domain, because an axis label naming a
 * value the chart does not reach is a lie about the data (plan Task 16 Step 2
 * is explicit about this). A zero-span or non-finite domain yields a single
 * tick rather than an infinite loop.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  if (max < min) return niceTicks(max, min, count)
  const rawStep = (max - min) / Math.max(1, count)
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const normalised = rawStep / magnitude
  const stepMultiple = normalised >= 5 ? 10 : normalised >= 2 ? 5 : normalised >= 1 ? 2 : 1
  const step = stepMultiple * magnitude
  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    // Re-round: repeated addition of e.g. 0.1 accumulates float error into the
    // label text, and "19.999999999999996 kWh" on an axis is unforgivable.
    ticks.push(Math.round(t / step) * step)
  }
  return ticks
}

/**
 * Even decimation to a row cap, always keeping the first and last row.
 *
 * The API already caps a session at 2000 points and a sample series at 5000;
 * this second pass exists because 5000 <path> vertices is more than an SVG
 * needs for a chart a few hundred pixels wide. It is decimation, not
 * truncation — the series still spans the whole window, and callers surface
 * that with the same `downsampled` wording the API uses.
 */
export function decimate<T>(rows: readonly T[], max: number): T[] {
  if (max < 2) return rows.length > 0 ? [rows[0]!] : []
  if (rows.length <= max) return [...rows]
  const step = (rows.length - 1) / (max - 1)
  const out: T[] = []
  for (let i = 0; i < max; i++) {
    out.push(rows[Math.round(i * step)]!)
  }
  // Guard the endpoint against float drift in the index arithmetic.
  out[out.length - 1] = rows[rows.length - 1]!
  return out
}

export interface Bounds {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

/**
 * Bounding box of a coordinate list, or null when nothing is locatable.
 *
 * `vehicle_location` is a separate OAuth scope, so a complete, valid drive can
 * have every lat/lon null. That must produce "no map", never a map fitted to
 * (0, 0) in the Gulf of Guinea.
 */
export function coordBounds(
  coords: readonly { lat: number | null; lon: number | null }[],
): Bounds | null {
  const lats = extent(coords.map((c) => c.lat))
  const lons = extent(coords.map((c) => c.lon))
  if (!lats || !lons) return null
  return { minLat: lats.min, minLon: lons.min, maxLat: lats.max, maxLon: lons.max }
}

/** [lon, lat] pairs for MapLibre, skipping any point missing either half. */
export function toLngLatPath(
  coords: readonly { lat: number | null; lon: number | null }[],
): [number, number][] {
  const out: [number, number][] = []
  for (const c of coords) {
    if (c.lat == null || c.lon == null) continue
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue
    out.push([c.lon, c.lat])
  }
  return out
}

/**
 * One line on a chart. Lives here rather than in the component because a
 * Svelte instance script cannot export a type, and both the pages that build
 * series and the component that draws them need the same shape.
 */
export interface ChartSeries {
  key: string
  label: string
  /** A CSS colour, normally a theme token: var(--accent), var(--driving). */
  color: string
  unit: string
  dp?: number
  /** x is epoch milliseconds for a time series; y is the value. */
  points: Point[]
  /** Two axes so a percentage and a temperature can share one frame. */
  axis?: 'left' | 'right'
  fill?: boolean
}
