import type { Gear } from '@ev/core'

/**
 * Rivian's `gearStatus` words, in the canonical letters the drive segmenter
 * reads (design §7.5). A Map, so a word like `constructor` is a string we cannot
 * name and not a property of Object.prototype.
 */
const GEARS: ReadonlyMap<string, Gear> = new Map<string, Gear>([
  ['park', 'P'],
  ['reverse', 'R'],
  ['neutral', 'N'],
  ['drive', 'D'],
])

/**
 * Read `gearStatus` as a canonical gear.
 *
 * THREE ANSWERS, because they mean three different things downstream:
 * - a letter, for a word we know (compared without regard to case);
 * - `null` for a string we cannot name, which the normaliser records as an
 *   EXPLICIT null gear. That includes the integration's placeholders
 *   (`fault`, `signal_not_available`, `undefined`), which are not gears. An
 *   explicit null overwrites an earlier `D`; leaving the gear undecoded would
 *   instead carry the `D` forward and hold a drive open, the bug commit 71aa244
 *   fixed for Tesla;
 * - `undefined` for anything that is not a string, which decodes NOTHING: the
 *   property was absent or malformed, and absent never becomes a value.
 *
 * Not trimmed: a gear with whitespace around it is not a word the vehicle
 * sends, and guessing at it is how a bad value gets vouched for.
 */
export function rivianGear(raw: unknown): Gear | null | undefined {
  if (typeof raw !== 'string') return undefined
  return GEARS.get(raw.toLowerCase()) ?? null
}
