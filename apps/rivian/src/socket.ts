import { USER_AGENT, type SubscriptionDocument } from '@ev/rivian'
import WebSocket from 'ws'

/**
 * ONE `graphql-transport-ws` CONNECTION TO RIVIAN (design §2.3, §5.2).
 *
 * This is the wire and nothing else. It connects, authenticates, tells the
 * caller what arrives, and tells the caller how it ended. What to subscribe to
 * is `SubscriptionPlan`'s business; when to try again is `Backoff`'s; what a
 * close MEANS (retry, or give up until the credential changes) is the
 * connector's. The one judgement made here is the one only this file can make:
 * reading the server's close reason, because Rivian puts its verdicts there.
 *
 * Nothing that comes off the wire, and no part of what goes onto it, is ever
 * put into an error message or a close detail (design §4.4). `connection_init`
 * carries the user session token and a `next` frame carries the car's data;
 * `ws` error messages can carry addresses. The details below are fixed
 * strings, a status code or an error code, so a detail is always safe to log
 * and to write to `rivian_status`.
 */

/**
 * How a connection ended, in the terms the connector acts on.
 *
 * - `rate_limited`: the server closed with the reason "Rate limited".
 * - `unauthenticated`: it closed with "Unauthenticated", which means the user
 *   session is dead. This is the one failure that is NEVER retried, because
 *   retrying a dead session is how accounts get flagged (design §5.2).
 * - `no_ack`: no `connection_ack` arrived within `ackTimeoutMs`.
 * - `closed`: any other close, or a drop with no close frame.
 * - `error`: the socket failed (refused, reset, an upgrade turned away, a
 *   frame `ws` could not read).
 */
export type CloseReason = 'rate_limited' | 'unauthenticated' | 'no_ack' | 'closed' | 'error'

export interface SocketHandlers {
  /** A `next` frame: `payload` is the whole `{ data, errors? }`, untouched. */
  onNext(id: string, payload: unknown): void
  /** An `error` frame: the server rejecting one subscription. `payload` is its error list. */
  onError(id: string, payload: unknown): void
  /** A `complete` frame: the server ending one subscription. */
  onComplete(id: string): void
  /**
   * The acknowledged socket is gone. Called at most once, and never after the
   * caller's own `close()`: a close the connector asked for is not news, and
   * reporting it back would have the connector schedule a reconnect for a
   * socket it had just discarded (or after it was told to stop).
   */
  onClose(reason: CloseReason, detail: string): void
}

export interface SocketLike {
  /** Send `subscribe` for `id`. Ignored if the socket is no longer open. */
  subscribe(id: string, doc: SubscriptionDocument): void
  /** Send `complete` for `id`. Ignored if the socket is no longer open. */
  complete(id: string): void
  /** Close the connection and stop reporting anything from it. */
  close(): void
}

/**
 * Why `openSocket` gave up, before there was a socket to hand back. `reason`
 * is a `CloseReason` and `message` the same safe detail `onClose` would get.
 * A close the server makes in place of the ack (a dead session answers
 * `connection_init` this way, plausibly) arrives here as `unauthenticated` or
 * `rate_limited`, and means exactly what it would mean after the ack.
 */
export class SocketOpenError extends Error {
  constructor(
    readonly reason: CloseReason,
    detail: string,
  ) {
    super(detail)
    this.name = 'SocketOpenError'
  }
}

const SUBPROTOCOL = 'graphql-transport-ws'

/**
 * The reasons Rivian closes with that mean something. The reason is matched by
 * its LEADING token, ignoring case and surrounding space: "Unauthenticated",
 * " unauthenticated ", and "Unauthenticated: session expired" all say the
 * session is dead, and "Rate limited" and "rate limited, retry later" both say
 * to slow down. Leading-token only, on purpose: the word in the middle of some
 * other sentence ("not unauthenticated") is not a verdict, and neither is a
 * longer word that merely starts with it ("unauthenticatedness").
 *
 * The matching leans towards `Unauthenticated`. Missing it turns a dead session
 * into an ordinary close, which is retried, and retrying a dead session is how
 * accounts get flagged (design §5.2). Only the verdict leaves this function:
 * the rest of the reason text is remote text and is never echoed anywhere.
 */
function closeReasonOf(text: string): 'rate_limited' | 'unauthenticated' | null {
  const reason = text.trim().toLowerCase()
  if (/^unauthenticated\b/.test(reason)) return 'unauthenticated'
  if (/^rate\s+limited\b/.test(reason)) return 'rate_limited'
  return null
}

/**
 * `graphql-transport-ws`'s own close codes for a connection the server will not
 * have: 4401 Unauthorized and 4403 Forbidden. Rivian says "Unauthenticated" in
 * the reason text, but a server is free to send either code with no text, or
 * with words the leading-token rule below has never heard of, and the code is
 * the protocol's statement of it. Retrying a dead session is how accounts get
 * flagged (design §5.2), so either code is the verdict whatever the text says,
 * including text that says something milder such as "Rate limited".
 */
const UNAUTHENTICATED_CLOSE_CODES: ReadonlySet<number> = new Set([4401, 4403])

/**
 * What to say about a socket error without repeating the error. A system error
 * code (ECONNREFUSED) and the HTTP status of a refused upgrade are fixed
 * vocabularies; the rest of the message can carry an address or a header and
 * is dropped.
 */
function errorDetail(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return `websocket error ${code}`
  const refused = err instanceof Error ? /^Unexpected server response: (\d{3})$/.exec(err.message) : null
  if (refused) return `websocket upgrade refused with HTTP ${refused[1]}`
  return 'websocket error'
}

/** A text frame as a string, whichever shape `ws` hands it over in. */
function frameText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Open a connection, send `connection_init`, and resolve once the server
 * answers `connection_ack`.
 *
 * Until the ack the socket is the caller's problem, reported by rejection:
 * `no_ack` if `ackTimeoutMs` runs out (the timer starts at the call, so a
 * connect that hangs is bounded too, and the connection is torn down), or the
 * `CloseReason` of whatever ended it first. After the ack, an ending is
 * reported to `handlers.onClose` instead, exactly once.
 *
 * It offers the `graphql-transport-ws` subprotocol and the app's user agent.
 * A server that will not speak the subprotocol turns the upgrade away, which
 * arrives as `error`.
 *
 * `WebSocketImpl` is the seam for a test that wants to see how the socket was
 * built. It is typed as the one constructor call made here, not as `typeof
 * WebSocket`, so that a stand-in class does not have to reproduce every
 * overload `ws` carries for its own server's use; `ws`'s own class satisfies it.
 */
export function openSocket(opts: {
  url: string
  initPayload: Record<string, string>
  ackTimeoutMs: number
  handlers: SocketHandlers
  WebSocketImpl?: new (
    address: string,
    protocols: string,
    options: WebSocket.ClientOptions,
  ) => WebSocket
}): Promise<SocketLike> {
  const { url, initPayload, ackTimeoutMs, handlers } = opts
  const Impl = opts.WebSocketImpl ?? WebSocket

  return new Promise<SocketLike>((resolve, reject) => {
    const ws = new Impl(url, SUBPROTOCOL, { headers: { 'User-Agent': USER_AGENT } })

    /**
     * `awaiting_ack` until the ack; `acked` while the caller has a socket;
     * `over` once it has been rejected, closed by the caller, or reported
     * closed. Nothing is reported to anyone once `over`.
     */
    let phase: 'awaiting_ack' | 'acked' | 'over' = 'awaiting_ack'

    /** The first thing that went wrong with the socket itself, if anything did. */
    let failure: string | undefined

    const ackTimer = setTimeout(() => {
      if (phase !== 'awaiting_ack') return
      phase = 'over'
      // A server that has not acknowledged in time is not going to, and a
      // closing handshake would wait on it. Drop the connection.
      ws.terminate()
      reject(new SocketOpenError('no_ack', `no connection_ack within ${ackTimeoutMs} ms`))
    }, ackTimeoutMs)

    const send = (message: unknown): void => {
      // A send after the socket went away would throw. The close has been, or
      // is about to be, reported, and the connector resubscribes everything on
      // the next socket, so a message that cannot go is not worth a throw.
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(message))
    }

    const socket: SocketLike = {
      subscribe: (id, doc) => send({ id, type: 'subscribe', payload: doc }),
      complete: (id) => send({ id, type: 'complete' }),
      close() {
        phase = 'over'
        ws.close(1000)
      },
    }

    ws.on('open', () => send({ type: 'connection_init', payload: initPayload }))

    ws.on('message', (data) => {
      if (phase === 'over') return
      let frame: unknown
      try {
        frame = JSON.parse(frameText(data))
      } catch {
        return
      }
      if (typeof frame !== 'object' || frame === null) return
      const { type, id, payload } = frame as { type?: unknown; id?: unknown; payload?: unknown }

      if (type === 'connection_ack') {
        if (phase !== 'awaiting_ack') return
        clearTimeout(ackTimer)
        phase = 'acked'
        resolve(socket)
        return
      }
      if (phase !== 'acked') return
      switch (type) {
        // The protocol's keep-alive. A server that sends a ping and hears no
        // pong closes the connection, so it is answered here.
        //
        // It is deliberately NOT surfaced to the handlers, so a ping does not
        // reset the connector's 60 s silence clock. Silence exists for the case
        // of a live socket whose subscriptions have gone quiet, and resubscribing
        // is what un-sticks that. A server that pings through the quiet would
        // otherwise keep the clock at zero for ever and the resubscribe would
        // never happen, which is the failure it is there to repair (design §5.2).
        case 'ping':
          send({ type: 'pong' })
          break
        case 'next':
          if (typeof id === 'string') handlers.onNext(id, payload)
          break
        case 'error':
          if (typeof id === 'string') handlers.onError(id, payload)
          break
        case 'complete':
          if (typeof id === 'string') handlers.onComplete(id)
          break
      }
    })

    ws.on('error', (err) => {
      failure ??= errorDetail(err)
      // After the handshake `ws` answers a bad frame by starting a closing
      // handshake and waiting up to 30 s for the peer. The connection is no use
      // after an error, so end it now rather than report it half a minute late.
      ws.terminate()
    })

    // `ws` emits `close` after every `error`, and after every other way a
    // connection can end, so this is the one place an ending is reported from.
    ws.on('close', (code, reasonBuffer) => {
      clearTimeout(ackTimer)
      if (phase === 'over') return
      const wasAcked = phase === 'acked'
      phase = 'over'

      const verdict = UNAUTHENTICATED_CLOSE_CODES.has(code)
        ? 'unauthenticated'
        : closeReasonOf(reasonBuffer.toString('utf8'))
      let reason: CloseReason
      let detail: string
      if (verdict === 'rate_limited') {
        reason = verdict
        detail = 'websocket closed: rate limited'
      } else if (verdict === 'unauthenticated') {
        reason = verdict
        detail = 'websocket closed: unauthenticated'
      } else if (failure !== undefined) {
        reason = 'error'
        detail = failure
      } else {
        reason = 'closed'
        detail = `websocket closed with code ${code}`
      }
      if (wasAcked) handlers.onClose(reason, detail)
      else reject(new SocketOpenError(reason, detail))
    })
  })
}
