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

// The ONE vendor-specific import in a browser module, and it is a subpath on
// purpose: `@ev/tesla` the barrel pulls jose and the whole Fleet API client in
// with it, none of which belongs in a page bundle. This file is pure string
// handling over the vendored proto's enum names.
import { teslaEnumLabel } from '@ev/tesla/enum-labels'

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

/* ------------------------------------------------------------------ *
 * Units
 * ------------------------------------------------------------------ *
 *
 * The app displays US imperial. Everything BEHIND this module stays SI: the
 * database columns, the ingest pipeline and the /api/v1 contract, whose field
 * names are themselves the units (`rangeKm`, `speedKph`, `efficiencyWhPerKm`).
 * A native app reading that contract gets metric, as documented.
 *
 * So this file is the ONLY place a conversion happens, and it happens on the
 * way to the screen. Two consequences worth stating, because both are easy to
 * undo by accident:
 *
 *  - The formatters below take CONTRACT units and render imperial. They are
 *    named for the quantity (`formatDistance`) rather than for either unit,
 *    because a `formatKm` that prints miles is a lie and a `formatMiles` that
 *    takes kilometres is a trap.
 *  - The converters are exported separately because the charts need converted
 *    NUMBERS, not strings: axis ticks are computed from the data, so a series
 *    left in km/h under an axis labelled mph would be wrong and look right.
 */

const KM_PER_MILE = 1.609344
const PSI_PER_BAR = 14.503773773022

/** null in, null out — the null discipline survives conversion. */
const convert = (f: (n: number) => number) => (v: Maybe): number | null =>
  v == null || !Number.isFinite(v) ? null : f(v)

export const kmToMi = convert((km) => km / KM_PER_MILE)
export const cToF = convert((c) => c * 1.8 + 32)
export const barToPsi = convert((bar) => bar * PSI_PER_BAR)

/**
 * Wh/km -> Wh/mi MULTIPLIES by kilometres per mile.
 *
 * Efficiency is energy PER distance, so it scales the opposite way to a
 * distance: a mile is longer than a kilometre, so covering one costs more
 * watt-hours. Dividing here — the instinct carried straight over from
 * `kmToMi` — would report the car as roughly half as thirsty as it is, which
 * is a believable enough number on screen that nobody would ever query it.
 */
export const whPerKmToWhPerMi = convert((whPerKm) => whPerKm * KM_PER_MILE)

export const formatDistance = (v: Maybe, dp = 1): string =>
  unit(formatNumber(kmToMi(v), dp), 'mi')
export const formatSpeed = (v: Maybe, dp = 0): string =>
  unit(formatNumber(kmToMi(v), dp), 'mph')
export const formatEfficiency = (v: Maybe): string =>
  unit(formatNumber(whPerKmToWhPerMi(v), 0), 'Wh/mi')
export const formatPressure = (v: Maybe): string =>
  unit(formatNumber(barToPsi(v), 1), 'psi')

/** Energy and power are identical in both systems: no conversion, ever. */
export const formatKwh = (v: Maybe, dp = 2): string => unit(formatNumber(v, dp), 'kWh')
export const formatKw = (v: Maybe, dp = 1): string => unit(formatNumber(v, dp), 'kW')

/** Volts, likewise identical everywhere. Whole volts: the tenth is noise. */
export const formatVolts = (v: Maybe, dp = 0): string => unit(formatNumber(v, dp), 'V')

/**
 * A vendor enum name, exactly as the car sent it.
 *
 * Enums are stored as the vendor's own string (design §2) and most of these
 * payloads have never been observed, so mapping 'ACSingleWireCAN' onto
 * something friendlier would be inventing a translation nothing can check —
 * and a wrong one would be indistinguishable from a right one on screen. A
 * blank string is a column written with nothing in it: not recorded.
 */
export function formatText(value: string | null | undefined): string {
  if (value == null) return DASH
  const trimmed = value.trim()
  if (trimmed === '') return DASH
  // The ONE transformation applied to a vendor enum, and it invents nothing:
  // `teslaEnumLabel` deletes a prefix the vendored proto itself defines, so
  // `SentryModeStateOff` reads `Off`. A value from an enum it does not know
  // comes back untouched, which keeps the guarantee above intact - what is on
  // screen is either the car's own word or the car's own word with its type
  // name removed, never a translation of it.
  return teslaEnumLabel(trimmed)
}

/**
 * A tri-state boolean. The third state is the reason this exists: a car that
 * has not said whether Sentry is on is not a car with Sentry off, and
 * `value ? on : off` would render every unreported flag as its negative.
 */
export function formatOnOff(
  value: boolean | null | undefined,
  on = 'On',
  off = 'Off',
): string {
  if (value == null) return DASH
  return value ? on : off
}

/** Percent. The value is already 0-100 in the contract, not 0-1. */
export function formatPct(value: Maybe, dp = 0): string {
  const n = formatNumber(value, dp)
  return n === DASH ? DASH : `${n}%`
}

/** Takes Celsius, renders Fahrenheit, degree sign attached to the number. */
export function formatTemp(value: Maybe, dp = 0): string {
  const n = formatNumber(cToF(value), dp)
  return n === DASH ? DASH : `${n}°F`
}

/** Odometer readings, rounded to whole miles: the last digit is never news. */
export function formatOdometer(value: Maybe): string {
  const n = formatInteger(kmToMi(value))
  return n === DASH ? DASH : `${n} mi`
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
