/**
 * Presentation helpers shared by every page.
 *
 * The one rule these exist to enforce is the contract's null discipline: the
 * API never substitutes 0 for a missing value, so the UI must never render a
 * missing value as 0 either. Every formatter here maps `null`/`undefined` to
 * an em dash and passes a real 0 straight through — "the car reported 0 kW"
 * and "the car did not report power" are different facts and a driver reading
 * the page has to be able to tell them apart.
 *
 * Formatting lives here rather than inline in markup so that this rule is
 * testable without a DOM: `test/format.test.ts` is the thing that fails if
 * someone reaches for `value || '—'` (which eats zeros) instead of a null check.
 */

/** The single "not recorded" glyph. Never '0', never 'N/A', never blank. */
export const DASH = '—'

type Maybe = number | null | undefined

/**
 * Fixed-precision number, or the dash.
 *
 * `Number.isFinite` rather than a truthiness check on purpose: 0 formats, NaN
 * and Infinity do not. A NaN reaching a page is a bug upstream, and rendering
 * "NaN km" in a status card hides it better than a dash does.
 */
export function formatNumber(value: Maybe, dp = 0): string {
  if (value == null || !Number.isFinite(value)) return DASH
  return value.toFixed(dp)
}

/** Thousands-separated integer, for odometers where the digits run long. */
export function formatInteger(value: Maybe): string {
  if (value == null || !Number.isFinite(value)) return DASH
  return Math.round(value).toLocaleString('en-GB')
}

export const formatKm = (v: Maybe, dp = 1): string => unit(formatNumber(v, dp), 'km')
export const formatKwh = (v: Maybe, dp = 2): string => unit(formatNumber(v, dp), 'kWh')
export const formatKw = (v: Maybe, dp = 1): string => unit(formatNumber(v, dp), 'kW')
export const formatKph = (v: Maybe, dp = 0): string => unit(formatNumber(v, dp), 'km/h')
export const formatWhPerKm = (v: Maybe): string => unit(formatNumber(v, 0), 'Wh/km')
export const formatBar = (v: Maybe): string => unit(formatNumber(v, 1), 'bar')

/** Percent. The value is already 0-100 in the contract, not 0-1. */
export function formatPct(value: Maybe, dp = 0): string {
  const n = formatNumber(value, dp)
  return n === DASH ? DASH : `${n}%`
}

/** Celsius, with the degree sign attached to the number rather than spaced. */
export function formatTempC(value: Maybe, dp = 0): string {
  const n = formatNumber(value, dp)
  return n === DASH ? DASH : `${n}°C`
}

/** Odometer readings, which are always whole kilometres in practice. */
export function formatOdometer(value: Maybe): string {
  const n = formatInteger(value)
  return n === DASH ? DASH : `${n} km`
}

/** Money, only ever called when `costCurrency` is set alongside `cost`. */
export function formatCost(value: Maybe, currency: string | null | undefined): string {
  if (value == null || !Number.isFinite(value) || !currency) return DASH
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value)
  } catch {
    // An unknown ISO code must not take the page down with it.
    return `${value.toFixed(2)} ${currency}`
  }
}

function unit(formatted: string, suffix: string): string {
  return formatted === DASH ? DASH : `${formatted} ${suffix}`
}

/**
 * Whole seconds as a human duration: "48s", "37m", "2h 04m".
 *
 * Open sessions carry `durationS: null` by contract, so null is the common
 * case here rather than an error. A negative duration means clock skew or a
 * bad row; it is shown as a dash rather than "-1h 00m", because a negative
 * duration is not a fact about the car.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return DASH
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Timestamps are ISO-8601 UTC strings by contract. They are rendered in the
 * host's local zone (the deployment sets TZ; the browser uses the viewer's),
 * because a drive at 07:31 local is what the driver remembers, not 06:31Z.
 * Tests pin `timeZone` so they do not depend on where they run.
 */
export interface TimeOptions {
  timeZone?: string
  locale?: string
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDateTime(iso: string | null | undefined, o: TimeOptions = {}): string {
  const d = parse(iso)
  if (!d) return DASH
  return new Intl.DateTimeFormat(o.locale ?? 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: o.timeZone,
  }).format(d)
}

export function formatDate(iso: string | null | undefined, o: TimeOptions = {}): string {
  const d = parse(iso)
  if (!d) return DASH
  return new Intl.DateTimeFormat(o.locale ?? 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: o.timeZone,
  }).format(d)
}

export function formatTime(iso: string | null | undefined, o: TimeOptions = {}): string {
  const d = parse(iso)
  if (!d) return DASH
  return new Intl.DateTimeFormat(o.locale ?? 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: o.timeZone,
  }).format(d)
}

/**
 * "4 minutes ago" for the freshness line under a live status card.
 *
 * Staleness is the point: a card showing 43% is only meaningful next to how
 * old that reading is, and an ingest outage shows up here first.
 */
export function formatRelative(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  const d = parse(iso)
  if (!d) return DASH
  const deltaS = Math.round((now.getTime() - d.getTime()) / 1000)
  const future = deltaS < 0
  const abs = Math.abs(deltaS)
  const [value, unitName]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60 ? [abs, 'second']
    : abs < 3600 ? [Math.floor(abs / 60), 'minute']
    : abs < 86400 ? [Math.floor(abs / 3600), 'hour']
    : [Math.floor(abs / 86400), 'day']
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' })
  return rtf.format(future ? value : -value, unitName)
}

/** A coordinate pair is only usable when BOTH halves are present. */
export function hasCoords(
  lat: number | null | undefined,
  lon: number | null | undefined,
): boolean {
  return lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)
}

/** Fallback label for a place we have coordinates for but no geocoding. */
export function formatCoords(
  lat: number | null | undefined,
  lon: number | null | undefined,
): string {
  if (!hasCoords(lat, lon)) return DASH
  return `${(lat as number).toFixed(4)}, ${(lon as number).toFixed(4)}`
}
