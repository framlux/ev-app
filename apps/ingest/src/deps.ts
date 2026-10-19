/**
 * The seam between the worker and its vendors.
 *
 * Re-exporting `@ev/core` from here keeps every other module importing from one
 * path, and `profileFor` below is where a vendor is chosen, so adding Rivian
 * touches this file and the profile it returns and nothing else.
 */
export * from '@ev/core'

import type { Vendor } from '@ev/core'
import type { VendorProfile } from './profile.js'
import { teslaProfile } from './profiles/tesla.js'

/**
 * The one place the worker chooses a vendor. EV_VENDOR picks the profile at
 * startup (config.ts), and every vendor-specific decision - decode, staleness,
 * the charge refresh, sample construction - lives behind it.
 */
export function profileFor(vendor: Vendor): VendorProfile {
  switch (vendor) {
    case 'tesla': return teslaProfile
    case 'rivian': throw new Error('no profile for vendor rivian yet')
  }
}
