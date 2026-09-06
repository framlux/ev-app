import { readFileSync } from 'node:fs'
import { env } from '$env/dynamic/private'
import {
	TeslaApiError,
	buildTelemetryConfig,
	checkTelemetryPreconditions,
	compareTelemetryConfig,
	hasCertificate,
	type AppliedTelemetryConfig,
	type Preflight,
	type VehicleInfo
} from '@ev/tesla'
import {
	findVehicleIdByVendorId,
	getPool,
	readTelemetryStatus,
	recordTelemetryCheck,
	recordTelemetryPush,
	withTransaction,
	type DbClient,
	type TelemetryCheck,
	type TelemetryStatus
} from './db.js'
import type {
	TelemetryCheckResult,
	TelemetryPushResult,
	TelemetryStatusDto
} from '../telemetry-types.js'
import { ApiProblem } from './queries.js'
import { clearTeslaToken, getTeslaToken } from './tesla-session.js'
import { teslaClient, type TeslaClient } from './tesla-client.js'

/**
 * The two things the telemetry page can DO: check, and push.
 *
 * Both are the same conversation with Tesla up to a point — resolve the VIN,
 * ask what the car has applied, run the preflight — and they must not answer
 * that conversation differently, because the check is how an operator decides
 * whether to push. So it is written once here and the push adds the two steps
 * the check does not have: refusing on a blocker, and sending the config.
 *
 * Everything the outside world does is INJECTED (`TelemetryDeps`) rather than
 * imported at the point of use. That is not test decoration: the failure this
 * module exists to prevent is a push to a physical car, and a test that can
 * count `setTelemetryConfig` calls is the only way to assert "nothing was
 * sent" for the two paths that must send nothing.
 *
 * Failures are `ApiProblem`, not SvelteKit's `error()`, for the reason
 * `queries.ts` gives: it keeps this module importable without a Kit runtime,
 * and `run()` in http.ts is the single place a problem becomes a response.
 */
export interface TelemetryDeps {
	/** Bound to ev-teslaproxy by `tesla-client.ts`; never @ev/tesla directly. */
	tesla: TeslaClient
	accessToken: string
	/** The CA the CAR pins, read lazily so a blocker is reported before it. */
	telemetryCa: () => string
	withDb: <T>(fn: (c: DbClient) => Promise<T>) => Promise<T>
	now: () => Date
}

/**
 * The three response shapes are declared in `$lib/telemetry-types.ts` and
 * re-exported here.
 *
 * They are what the page reads back out of `fetch`, and a page cannot import
 * anything under `$lib/server` — so a single definition has to live outside it.
 * Re-exporting keeps this module the one import path the routes and the tests
 * already use.
 */
export type {
	TelemetryCheckResult,
	TelemetryPushResult,
	TelemetryStatusDto
} from '../telemetry-types.js'

/* ------------------------------------------------------------------ *
 * The shared half
 * ------------------------------------------------------------------ */

interface Observed {
	vin: string
	vehicleId: string
	synced: boolean
	/** Absent until the car has applied a configuration; Tesla omits the key. */
	applied: AppliedTelemetryConfig | undefined
	preflight: Preflight
	firmware: string | null
	keyPaired: boolean
	streamingEnabled: boolean | null
}

/**
 * One vehicle, or a refusal. The script refuses to guess and so does this: a
 * configuration pushed to the wrong VIN is invisible until data arrives from
 * the wrong car, which is far worse than an error message (§5).
 */
async function resolveVin(deps: TelemetryDeps): Promise<string> {
	const vehicles = await deps.tesla.listVehicles(deps.accessToken)
	const first = vehicles[0]
	if (!first) throw new ApiProblem(409, 'the Tesla account lists no vehicles')
	if (vehicles.length > 1) {
		throw new ApiProblem(
			409,
			`the Tesla account lists ${vehicles.length} vehicles (${vehicles
				.map((v) => v.vin)
				.join(', ')}); this application configures one car and refuses to guess`
		)
	}
	return first.vin
}

/**
 * The VIN is Tesla's identifier; every row in this schema is keyed by the local
 * `vehicle.id`. Resolved BEFORE anything is sent to the car, so a deployment
 * whose ingest worker was never pointed at this VIN refuses instead of
 * reconfiguring a vehicle it then cannot record having reconfigured.
 */
async function resolveVehicleId(deps: TelemetryDeps, vin: string): Promise<string> {
	const id = await deps.withDb((c) => findVehicleIdByVendorId(c, 'tesla', vin))
	if (!id) {
		throw new ApiProblem(
			409,
			`Tesla reports VIN ${vin}, but no vehicle row exists for it — the ingest ` +
				'worker registers the vehicle it is configured for, and this deployment ' +
				'has not registered this one'
		)
	}
	return id
}

/**
 * Everything both actions need, in the two Fleet API reads neither can skip.
 *
 * Issued in parallel because they are independent and this runs while an
 * operator watches a button: `fleet_telemetry_config` says what the car has,
 * `fleet_status` says whether it could apply anything at all.
 */
async function observe(deps: TelemetryDeps): Promise<Observed> {
	const vin = await resolveVin(deps)
	const [applied, status] = await Promise.all([
		deps.tesla.getTelemetryConfig(deps.accessToken, vin),
		deps.tesla.fleetStatus(deps.accessToken, [vin])
	])
	const vehicleId = await resolveVehicleId(deps, vin)

	const info: VehicleInfo | undefined = status.vehicle_info?.[vin]
	const keyPaired = (status.key_paired_vins ?? []).includes(vin)
	return {
		vin,
		vehicleId,
		// `synced` is what the car reports; everything else in the echo is ignored.
		synced: applied.synced === true,
		applied: applied.config,
		preflight: checkTelemetryPreconditions(vin, info, keyPaired),
		firmware: info?.firmware_version ?? null,
		keyPaired,
		// `null` and `false` are different answers here: false means the owner
		// must turn the toggle on, null means the car does not use it at all.
		streamingEnabled: info?.safety_screen_streaming_toggle_enabled ?? null
	}
}

/**
 * What this observation asserts about the car, in the row's shape.
 *
 * Every field is stated, including the nulls: `TelemetryCheck` requires them
 * because an omitted field would read as "unchanged" against the upsert, which
 * is a claim about the car that this observation did not make.
 */
function toCheck(o: Observed, checkedAt: Date): TelemetryCheck {
	return {
		vehicleId: o.vehicleId,
		synced: o.synced,
		fieldCount: o.applied ? Object.keys(o.applied.fields ?? {}).length : null,
		// Presence, by the same predicate the builder and the §3.6 comparison
		// use — imported rather than re-spelled, so the stored flag and the
		// push decision cannot come to disagree about the same bytes.
		caPresent: o.applied ? hasCertificate(o.applied.ca ?? '') : null,
		firmware: o.firmware,
		keyPaired: o.keyPaired,
		streamingEnabled: o.streamingEnabled,
		checkedAt
	}
}

/**
 * One row, one JSON shape — exported because the PAGE LOAD reads the same row
 * (§3.8's "the applied status with its age", which it must show with no Tesla
 * session at all) and then replaces it wholesale with what a check answers. Two
 * mappings would let the page's rendering of a cached row and its rendering of
 * a fresh one disagree about the same nine columns.
 */
export function toTelemetryStatusDto(row: TelemetryStatus): TelemetryStatusDto {
	return {
		vehicleId: row.vehicleId,
		synced: row.synced,
		fieldCount: row.fieldCount,
		caPresent: row.caPresent,
		firmware: row.firmware,
		keyPaired: row.keyPaired,
		streamingEnabled: row.streamingEnabled,
		checkedAt: row.checkedAt?.toISOString() ?? null,
		pushedAt: row.pushedAt?.toISOString() ?? null
	}
}

/** Read back inside the writing transaction, so the caller sees one state. */
async function writeAndRead(
	deps: TelemetryDeps,
	write: (c: DbClient) => Promise<void>,
	vehicleId: string
): Promise<TelemetryStatusDto> {
	const row = await deps.withDb(async (c) => {
		await write(c)
		return readTelemetryStatus(c, vehicleId)
	})
	// Unreachable: the write above created the row in the same transaction.
	if (!row) throw new Error(`telemetry_status vanished for ${vehicleId} after writing it`)
	return toTelemetryStatusDto(row)
}

/* ------------------------------------------------------------------ *
 * Check
 * ------------------------------------------------------------------ */

/**
 * Ask the car what it has, record it, and hand back the row.
 *
 * Recording is the point as much as reporting: §3.7's cached row is what makes
 * the page useful the other twenty-three hours of the day, when nobody is
 * consented to Tesla at all.
 */
export async function checkTelemetry(deps: TelemetryDeps): Promise<TelemetryCheckResult> {
	const observed = await observe(deps)
	const checkedAt = deps.now()

	// RECORD FIRST, COMPARE SECOND, and the order is the point.
	//
	// The comparison needs the telemetry CA, which is a file mount that can be
	// missing, empty or mis-projected — and building the desired config throws
	// on exactly that (§3.5's guard). If that throw happened before the write,
	// a bad CA would turn "Check now" into a 500 that records nothing, and the
	// cached row in §3.7 is precisely what has to survive for the page to be
	// useful with no Tesla session. What the car reported is worth keeping even
	// when we cannot say whether it matches. The push path defers its CA read
	// past the preflight for the same reason.
	const status = await writeAndRead(
		deps,
		(c) => recordTelemetryCheck(c, toCheck(observed, checkedAt)),
		observed.vehicleId
	)

	const comparison = compareAgainstCatalogue(deps, observed)

	return {
		vin: observed.vin,
		status,
		blockers: observed.preflight.blockers,
		warnings: observed.preflight.warnings,
		matches: comparison.matches,
		differences: comparison.differences,
		desiredFieldCount: comparison.desiredFieldCount
	}
}

/**
 * What the catalogue would push, compared with what the car has.
 *
 * Returns a NEGATIVE answer rather than throwing when the desired config
 * cannot be built at all — a missing or malformed telemetry CA mount, which
 * `buildTelemetryConfig` refuses (§3.5). "We cannot tell" is reported as "does
 * not match", with the reason as the difference, because the alternative is a
 * check that fails wholesale and records nothing. A push in that state refuses
 * on the same error, which is the honest outcome: a config we cannot build is
 * a config we must not send.
 */
function compareAgainstCatalogue(
	deps: TelemetryDeps,
	observed: Observed
): { matches: boolean; differences: string[]; desiredFieldCount: number } {
	let desired
	try {
		desired = buildTelemetryConfig({ vin: observed.vin, ca: deps.telemetryCa() }).config
	} catch (err) {
		return {
			matches: false,
			differences: [
				`cannot build the configuration to compare against: ${err instanceof Error ? err.message : String(err)}`
			],
			desiredFieldCount: 0
		}
	}
	const comparison = compareTelemetryConfig(observed.applied, desired)
	return { ...comparison, desiredFieldCount: Object.keys(desired.fields).length }
}

/* ------------------------------------------------------------------ *
 * Push
 * ------------------------------------------------------------------ */

/**
 * Reconfigure the car — but only after establishing that it can apply the
 * configuration and does not already have it.
 *
 * Two of the three outcomes send NOTHING. All three WRITE, because the
 * observation is worth keeping whatever the outcome: migration 006 justifies
 * the firmware, key_paired and streaming_enabled columns on the grounds that
 * "the page can say WHY it will not push before anyone consents to Tesla
 * again", and a refusal that discarded the very observation that produced it
 * would leave the page showing a preflight from some earlier check — or three
 * dashes, on day one. §3.7 says the row is written on every check and every
 * push.
 *
 * The two that send nothing:
 *
 *  - A preflight blocker (§3.6). Tesla ACCEPTS a configuration a car cannot
 *    apply, reports no error, and leaves `synced: false` indefinitely — which
 *    is indistinguishable from a sleeping car. Pushing anyway would replace a
 *    precise diagnosis with an unfalsifiable wait.
 *  - An identical applied configuration. There is nothing to do, and doing it
 *    anyway means a physical car reconfigured on every mis-click.
 *
 * The third outcome writes both halves of the row: the observation the
 * preflight made, and `pushed_at`. They go in one transaction because they are
 * one event, and a push that recorded only `pushed_at` would leave the page
 * showing a stale firmware and key-paired state next to a fresh push time.
 */
export async function pushTelemetry(deps: TelemetryDeps): Promise<TelemetryPushResult> {
	const observed = await observe(deps)

	if (!observed.preflight.ok) {
		// Recorded before the refusal: this observation is the diagnosis, and it
		// is the answer to "why will it not push" that the page must be able to
		// give with no Tesla session at all.
		await writeAndRead(
			deps,
			(c) => recordTelemetryCheck(c, toCheck(observed, deps.now())),
			observed.vehicleId
		)
		throw new ApiProblem(
			409,
			`the car cannot apply a telemetry configuration: ${observed.preflight.blockers.join(
				' '
			)} Nothing was sent to Tesla.`
		)
	}

	// Built only now: a bad CA mount must not be reported ahead of a blocker
	// the operator can actually act on, and the builder throws on one.
	const request = buildTelemetryConfig({ vin: observed.vin, ca: deps.telemetryCa() })
	const comparison = compareTelemetryConfig(observed.applied, request.config)
	const desiredFieldCount = Object.keys(request.config.fields).length

	// Only when the car SAYS it has applied it. `synced: false` with a matching
	// config is the state where Tesla has taken a configuration the car has not
	// yet acknowledged, and reporting "already applied" there would be the
	// too-loose half of §3.6: a push silently declined over a car that never
	// received one. Matching-but-unsynced therefore pushes.
	if (comparison.matches && observed.synced) {
		const status = await writeAndRead(
			deps,
			(c) => recordTelemetryCheck(c, toCheck(observed, deps.now())),
			observed.vehicleId
		)
		return {
			vin: observed.vin,
			pushed: false,
			alreadyApplied: true,
			desiredFieldCount,
			warnings: observed.preflight.warnings,
			differences: [],
			pushedAt: null,
			status
		}
	}

	const result = await deps.tesla.setTelemetryConfig(deps.accessToken, request)

	// Tesla answers 200 while listing the vehicles it declined, keyed by reason.
	// Treating that as success is the exact failure this whole feature exists to
	// remove: a push that "worked" and changed nothing.
	const refused = Object.entries(result.skipped_vehicles ?? {})
		.filter(([, vins]) => vins.includes(observed.vin))
		.map(([reason]) => reason)
	if (refused.length > 0) {
		throw new ApiProblem(
			502,
			`Tesla accepted the request but skipped ${observed.vin}: ${refused.join(', ')}`
		)
	}

	// A 200 that updated nothing and skipped nothing is not a success either.
	// It is the same failure as a skip — a push that "worked" and changed
	// nothing — arriving without the courtesy of a reason, so it must not be
	// recorded as a push.
	if (result.updated_vehicles === 0) {
		throw new ApiProblem(
			502,
			`Tesla accepted the request but reported no vehicle updated, and gave no reason. ${observed.vin} may not have been reconfigured.`
		)
	}

	// One clock reading for both writes. The observation was made moments ago in
	// the same handler, and two readings would put a `checked_at` after a
	// `pushed_at` that describes the same button press.
	const at = deps.now()
	const status = await writeAndRead(
		deps,
		async (c) => {
			await recordTelemetryCheck(c, toCheck(observed, at))
			await recordTelemetryPush(c, observed.vehicleId, at)
		},
		observed.vehicleId
	)

	return {
		vin: observed.vin,
		pushed: true,
		alreadyApplied: false,
		desiredFieldCount,
		warnings: observed.preflight.warnings,
		differences: comparison.differences,
		pushedAt: at.toISOString(),
		status
	}
}

/* ------------------------------------------------------------------ *
 * What the routes wrap around them
 * ------------------------------------------------------------------ */

/**
 * The CA the CAR pins, which is NOT the CA that makes the proxy trustworthy.
 *
 * Two certificates are in play and confusing them is the expensive mistake.
 * The PROXY's CA is trust: it is `NODE_EXTRA_CA_CERTS` on the pod, applied by
 * Node to the process trust store, and no application code reads it (§3.3).
 * This one is PAYLOAD: it is projected from `ev-telemetry-ca` and travels
 * inside the configuration, where the car pins it. A configuration carrying the
 * wrong bytes is accepted and then fails every connection, which looks exactly
 * like a car that never wakes — so the builder greps it for BEGIN CERTIFICATE,
 * as the shell script did.
 *
 * Read per call rather than at import: a re-projected Secret must not need a
 * pod restart to take effect, and a file read on a button press is free.
 */
export function telemetryCa(): string {
	const path = env['TELEMETRY_CA_FILE']
	if (!path) throw new Error('TELEMETRY_CA_FILE is not set')
	try {
		return readFileSync(path, 'utf8')
	} catch (e) {
		// By path, because "the mount is missing" and "the projection named the
		// wrong key" produce the same symptom and different fixes.
		throw new Error(`the telemetry CA at ${path} could not be read: ${String(e)}`)
	}
}

/** Production wiring. Nothing here is reachable from a test by design. */
function productionDeps(accessToken: string): TelemetryDeps {
	return {
		tesla: teslaClient(),
		accessToken,
		telemetryCa,
		// One statement per transaction is a shade more ceremony than it needs,
		// but a second convention for who may call a repository is worse.
		withDb: (fn) => withTransaction(getPool(), fn),
		now: () => new Date()
	}
}

/**
 * Tesla said the token is no longer good.
 *
 * This used to match `/failed: 401\b/` against the message, because @ev/tesla
 * threw a plain `Error` with the status in its text. It now throws
 * `TeslaApiError`, so the status is read rather than parsed out of prose — the
 * same judgement, no longer one error-message rewording away from treating a
 * dead consent as a server fault.
 */
export function isTeslaUnauthorized(e: unknown): boolean {
	return e instanceof TeslaApiError && e.status === 401
}

/**
 * What Tesla refused, in words the operator can act on.
 *
 * Both refusals this app has had were precise — `Unknown field
 * BrickSocMinPercent`, and `SelfDrivingMilesSinceReset requires minimum delta
 * be explicitly set and >= 1` — and both reached the operator as a 500 and a
 * stack trace in a pod log, because an unrecognised error is rethrown and Kit
 * turns that into "Internal Error". The sentence naming the exact problem was
 * the one thing not on the screen.
 *
 * 502 rather than 500: the refusal is upstream's answer, not this server
 * failing, and the page renders the message of a Kit error. The txid rides
 * along because it is what Tesla asks for when reporting a problem, and it is
 * useless if it only ever exists in a log nobody exports.
 *
 * A 401 is deliberately NOT handled here — it is a dead consent, handled above,
 * and answering it with "Tesla refused" would leave a token in memory that can
 * never work again.
 */
export function teslaRefusal(e: unknown): ApiProblem | null {
	if (!(e instanceof TeslaApiError) || e.status === 401) return null
	const detail = e.teslaError ?? e.message
	const description =
		e.teslaErrorDescription === null ? '' : ` (${e.teslaErrorDescription})`
	const txid = e.txid === null ? '' : ` [Tesla txid ${e.txid}]`
	return new ApiProblem(502, `Tesla refused the request: ${detail}${description}${txid}`)
}

/**
 * §5: "cannot reach the signing proxy" and "the CA is wrong" have completely
 * different fixes, so they must not arrive as the same 502.
 *
 * Node's fetch reports both as a TypeError with the real reason on `cause`, so
 * the classification is on the cause's code. Anything else is not a transport
 * problem and is left alone.
 */
export function teslaTransportProblem(e: unknown): ApiProblem | null {
	const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code
	if (typeof code !== 'string') return null
	if (/^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(code)) {
		return new ApiProblem(
			502,
			`the signing proxy's certificate could not be verified (${code}): NODE_EXTRA_CA_CERTS ` +
				'must point at the proxy CA on this pod'
		)
	}
	if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH)$/.test(code)) {
		return new ApiProblem(502, `the signing proxy could not be reached (${code})`)
	}
	return null
}

/**
 * The consent policy every action shares: refuse without one, and drop a dead
 * one rather than retrying with it (§5).
 *
 * 409 for "no Tesla session" is asserted here rather than left to the UI. The
 * buttons are disabled without a connection, but the UI is not the check — an
 * API that trusted it would be one stale page away from a 500.
 */
export async function withTeslaSession<T>(
	subject: string,
	action: (deps: TelemetryDeps) => Promise<T>
): Promise<T> {
	const token = getTeslaToken(subject)
	if (!token) throw new ApiProblem(409, 'connect to Tesla first')
	try {
		return await action(productionDeps(token.accessToken))
	} catch (e) {
		if (isTeslaUnauthorized(e)) {
			// Expired, revoked, or consent withdrawn — all three are dead and none
			// is retryable, so the credential leaves memory here as well as at its
			// expiry. There is no refresh token to renew it with, deliberately.
			clearTeslaToken(subject)
			throw new ApiProblem(409, 'the Tesla connection is no longer valid; connect to Tesla again')
		}
		const transport = teslaTransportProblem(e)
		if (transport) throw transport
		const refusal = teslaRefusal(e)
		if (refusal) throw refusal
		throw e
	}
}
