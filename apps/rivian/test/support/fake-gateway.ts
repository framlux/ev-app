import type { AppSession, RivianHttp } from '@ev/rivian'

/**
 * A stand-in for `RivianHttp`, in this process: each method answers from a
 * script and counts its calls. Tests never reach the network, and never need
 * to say more about Rivian than the one thing each test is about.
 *
 * Every method is scripted with a list of outcomes. Each call takes the next
 * one, and the LAST outcome repeats for ever, so a test that says "this call
 * fails once, then works" writes two outcomes and one that says "this call
 * always works" writes one. An outcome is a value, an `Error` to throw, or a
 * function (which may itself return or throw), for the cases where the answer
 * depends on what was asked.
 */
export type Method =
  | 'createCsrf'
  | 'userInfo'
  | 'vehicle'
  | 'chargingSummaries'
  | 'introspectVehicleState'

export type Outcome<T = unknown> = T | Error | (() => T | Promise<T>)

/** A `getUserInfo` answer listing these vehicles, in the shape `findVehicle` reads. */
export function userInfoWith(vehicles: { id: string; vin: string }[]): unknown {
  return {
    currentUser: {
      id: 'user-1',
      vehicles: vehicles.map((v) => ({ id: v.id, vin: v.vin, name: 'R2', state: 'ACTIVE' })),
    },
  }
}

export class FakeGateway implements Pick<RivianHttp, Method> {
  /** How many times each method has been called. */
  readonly calls: Record<Method, number> = {
    createCsrf: 0,
    userInfo: 0,
    vehicle: 0,
    chargingSummaries: 0,
    introspectVehicleState: 0,
  }

  /** The user session token each authenticated call was made with, in order. */
  readonly tokens: string[] = []

  readonly #scripts: Record<Method, Outcome[]>

  constructor(vin: string) {
    let csrfs = 0
    this.#scripts = {
      createCsrf: [
        () => {
          csrfs += 1
          return { csrfToken: `csrf-${csrfs}`, appSessionToken: `app-${csrfs}` }
        },
      ],
      userInfo: [userInfoWith([{ id: 'rv-1', vin }])],
      vehicle: [{ getVehicle: { id: 'rv-1', vin } }],
      chargingSummaries: [{ getCompletedSessionSummaries: [] }],
      introspectVehicleState: [{ __type: { fields: [] } }],
    }
  }

  /** Replace what `method` answers with these outcomes, the last repeating. */
  script(method: Method, ...outcomes: Outcome[]): void {
    if (outcomes.length === 0) throw new Error('script needs at least one outcome')
    this.#scripts[method] = outcomes
  }

  createCsrf = (): Promise<AppSession> => this.#answer('createCsrf') as Promise<AppSession>

  userInfo = (_app: AppSession, token: string): Promise<unknown> => {
    this.tokens.push(token)
    return this.#answer('userInfo')
  }

  vehicle = (_app: AppSession, token: string, _vehicleId: string): Promise<unknown> => {
    this.tokens.push(token)
    return this.#answer('vehicle')
  }

  chargingSummaries = (_app: AppSession, token: string, _vehicleId: string): Promise<unknown> => {
    this.tokens.push(token)
    return this.#answer('chargingSummaries')
  }

  introspectVehicleState = (_app: AppSession, token: string): Promise<unknown> => {
    this.tokens.push(token)
    return this.#answer('introspectVehicleState')
  }

  async #answer(method: Method): Promise<unknown> {
    this.calls[method] += 1
    const script = this.#scripts[method]
    const outcome = script.length > 1 ? script.shift()! : script[0]!
    if (outcome instanceof Error) throw outcome
    return typeof outcome === 'function' ? (outcome as () => unknown)() : outcome
  }
}
