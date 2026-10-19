import { USER_AGENT, vehicleStateDocument } from '@ev/rivian'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  SocketOpenError,
  openSocket,
  type CloseReason,
  type SocketHandlers,
  type SocketLike,
} from '../src/socket.js'
import { startFakeRivianWs, type FakeRivianWs } from './support/fake-rivian-ws.js'

const INIT = { 'client-name': 'test-client', 'client-version': '1.0.0', 'dc-cid': 'm-ios-1', 'u-sess': 'a-session' }
const DOC = vehicleStateDocument('veh-1', ['powerState'])

/** Everything the socket told its handlers, in order. */
interface Calls {
  next: [string, unknown][]
  error: [string, unknown][]
  complete: string[]
  close: [CloseReason, string][]
}

function recorder(): { calls: Calls; handlers: SocketHandlers } {
  const calls: Calls = { next: [], error: [], complete: [], close: [] }
  return {
    calls,
    handlers: {
      onNext: (id, payload) => calls.next.push([id, payload]),
      onError: (id, payload) => calls.error.push([id, payload]),
      onComplete: (id) => calls.complete.push(id),
      onClose: (reason, detail) => calls.close.push([reason, detail]),
    },
  }
}

let server: FakeRivianWs
const sockets: SocketLike[] = []

beforeEach(async () => {
  server = await startFakeRivianWs()
})

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close()
  await server.stop()
})

/** Open a socket against the fake and keep it for cleanup. */
async function open(
  handlers: SocketHandlers,
  over: Partial<Parameters<typeof openSocket>[0]> = {},
): Promise<SocketLike> {
  const socket = await openSocket({
    url: server.url,
    initPayload: INIT,
    ackTimeoutMs: 1_000,
    handlers,
    ...over,
  })
  sockets.push(socket)
  return socket
}

describe('openSocket: connecting', () => {
  it('resolves on connection_ack', async () => {
    const { handlers } = recorder()
    const socket = await open(handlers)
    expect(socket).toBeDefined()
    expect(server.inits).toHaveLength(1)
  })

  it('sends connection_init with exactly the payload it was given', async () => {
    const { handlers } = recorder()
    await open(handlers)
    expect(server.inits).toEqual([INIT])
  })

  it('offers the graphql-transport-ws subprotocol and the app user agent', async () => {
    // The fake refuses an upgrade that does not offer the subprotocol, so
    // reaching the ack at all proves the offer; the header is checked here.
    const { handlers } = recorder()
    await open(handlers)
    expect(server.upgradeHeaders[0]?.['sec-websocket-protocol']).toBe('graphql-transport-ws')
    expect(server.upgradeHeaders[0]?.['user-agent']).toBe(USER_AGENT)
  })

  it('rejects with no_ack, and closes, when no ack comes within ackTimeoutMs', async () => {
    server.ack = false
    const { calls, handlers } = recorder()
    const started = Date.now()
    const failure = await openSocket({
      url: server.url,
      initPayload: INIT,
      ackTimeoutMs: 50,
      handlers,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(SocketOpenError)
    expect(failure).toMatchObject({ reason: 'no_ack' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    // The server side sees the connection end: nothing is left dangling.
    await server.until(() => server.closedClients === 1)
    // A socket that never became usable reports through the rejection alone.
    expect(calls.close).toEqual([])
  })

  it('rejects with unauthenticated when the server closes that way instead of acking', async () => {
    // A dead session is most likely to show as a close in answer to
    // connection_init, before any ack. It must reach the caller as
    // `unauthenticated`, which is the one failure that must NOT be retried.
    server.ack = false
    const pending = openSocket({ url: server.url, initPayload: INIT, ackTimeoutMs: 1_000, handlers: recorder().handlers })
    await server.until(() => server.inits.length === 1)
    server.closeWith(4401, 'Unauthenticated')
    await expect(pending).rejects.toMatchObject({ reason: 'unauthenticated' })
  })

  it('rejects with rate_limited when the server closes that way instead of acking', async () => {
    server.ack = false
    const pending = openSocket({ url: server.url, initPayload: INIT, ackTimeoutMs: 1_000, handlers: recorder().handlers })
    await server.until(() => server.inits.length === 1)
    server.closeWith(4429, 'Rate limited')
    await expect(pending).rejects.toMatchObject({ reason: 'rate_limited' })
  })

  it('rejects with closed when the server just drops the connection before the ack', async () => {
    server.ack = false
    const pending = openSocket({ url: server.url, initPayload: INIT, ackTimeoutMs: 1_000, handlers: recorder().handlers })
    await server.until(() => server.inits.length === 1)
    server.dropClients()
    await expect(pending).rejects.toMatchObject({ reason: 'closed' })
  })

  it('rejects with error when nothing is listening', async () => {
    const dead = await startFakeRivianWs()
    const url = dead.url
    await dead.stop()
    const failure = await openSocket({ url, initPayload: INIT, ackTimeoutMs: 1_000, handlers: recorder().handlers }).catch(
      (e: unknown) => e,
    )
    expect(failure).toMatchObject({ reason: 'error' })
    // The detail is safe to log: a code, never the address or a message.
    expect((failure as SocketOpenError).message).toMatch(/^websocket error( [A-Z_]+)?$/)
  })

  it('rejects with error when the server refuses the upgrade', async () => {
    // A server that will not speak the subprotocol answers the upgrade with a
    // 400. ws reports that as "Unexpected server response: 400"; the status is
    // kept and the rest is not.
    const failure = await openSocket({
      url: server.url,
      initPayload: INIT,
      ackTimeoutMs: 1_000,
      handlers: recorder().handlers,
      // A client that offers no subprotocol: the fake must turn it away.
      WebSocketImpl: class NoProtocol extends WebSocket {
        constructor(url: string, _protocols: string, options: WebSocket.ClientOptions) {
          super(url, [], options)
        }
      },
    }).catch((e: unknown) => e)
    expect(failure).toMatchObject({ reason: 'error' })
    expect((failure as SocketOpenError).message).toBe('websocket upgrade refused with HTTP 400')
  })

  it('uses the WebSocket implementation it is given', async () => {
    const seen: string[] = []
    class Spy extends WebSocket {
      constructor(url: string, protocols: string, options: WebSocket.ClientOptions) {
        seen.push(protocols)
        super(url, protocols, options)
      }
    }
    await open(recorder().handlers, { WebSocketImpl: Spy })
    expect(seen).toEqual(['graphql-transport-ws'])
  })
})

describe('openSocket: an acknowledged socket', () => {
  it('sends subscribe with the id and the document as payload', async () => {
    const socket = await open(recorder().handlers)
    socket.subscribe('state:0#1', DOC)
    await server.until(() => server.subscribes.length === 1)
    expect(server.subscribes[0]).toEqual({ id: 'state:0#1', payload: JSON.parse(JSON.stringify(DOC)) })
  })

  it('sends complete for an id', async () => {
    const socket = await open(recorder().handlers)
    socket.complete('state:0#1')
    await server.until(() => server.completes.length === 1)
    expect(server.completes).toEqual(['state:0#1'])
  })

  it('routes next, error and complete frames to the handlers, by id', async () => {
    const { calls, handlers } = recorder()
    await open(handlers)
    server.sendNext('a#1', { data: { vehicleState: { powerState: { value: 'sleep' } } } })
    server.sendError('b#2', [{ message: 'nope', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }])
    server.sendComplete('c#3')
    await server.until(() => calls.next.length + calls.error.length + calls.complete.length === 3)
    expect(calls.next).toEqual([['a#1', { data: { vehicleState: { powerState: { value: 'sleep' } } } }]])
    expect(calls.error).toEqual([['b#2', [{ message: 'nope', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }]]])
    expect(calls.complete).toEqual(['c#3'])
  })

  it('ignores frames it cannot read, and carries on', async () => {
    const { calls, handlers } = recorder()
    await open(handlers)
    // Raw junk, a frame with no type, an unknown type and a next with no id:
    // none may throw out of the socket or reach a handler.
    server.sendRaw('not json')
    server.sendRaw('42')
    server.sendRaw(JSON.stringify({ id: 'x#1' }))
    server.sendRaw(JSON.stringify({ id: 'x#1', type: 'who-knows' }))
    server.sendRaw(JSON.stringify({ type: 'next', payload: {} }))
    server.sendNext('real#1', { ok: true })
    await server.until(() => calls.next.length === 1)
    expect(calls.next).toEqual([['real#1', { ok: true }]])
    expect(calls.close).toEqual([])
  })

  it('answers a ping with a pong, and does not show it to the handlers', async () => {
    const { calls, handlers } = recorder()
    await open(handlers)
    server.sendPing()
    await server.until(() => server.pongs === 1)
    expect(calls.next).toEqual([])
  })

  it('calls onClose once, with rate_limited, for the close reason "Rate limited"', async () => {
    const { calls, handlers } = recorder()
    await open(handlers)
    server.closeWith(4429, 'Rate limited')
    await server.until(() => calls.close.length === 1)
    expect(calls.close[0]?.[0]).toBe('rate_limited')
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.close).toHaveLength(1)
  })

  it('calls onClose with unauthenticated for the close reason "Unauthenticated"', async () => {
    const { calls, handlers } = recorder()
    await open(handlers)
    server.closeWith(4401, 'Unauthenticated')
    await server.until(() => calls.close.length === 1)
    expect(calls.close[0]?.[0]).toBe('unauthenticated')
  })

  it('calls onClose with closed for any other close, and keeps the server text out of the detail', async () => {
    const { calls, handlers } = recorder()
    await open(handlers)
    server.closeWith(1011, 'internal: token=abcdef0123456789')
    await server.until(() => calls.close.length === 1)
    expect(calls.close[0]?.[0]).toBe('closed')
    expect(calls.close[0]?.[1]).toBe('websocket closed with code 1011')
  })

  it('calls onClose with closed when the connection is dropped without a close frame', async () => {
    const { calls, handlers } = recorder()
    await open(handlers)
    server.dropClients()
    await server.until(() => calls.close.length === 1)
    expect(calls.close[0]?.[0]).toBe('closed')
    expect(calls.close[0]?.[1]).toBe('websocket closed with code 1006')
  })

  it('matches the close reason without regard to case or surrounding space', async () => {
    const { calls, handlers } = recorder()
    await open(handlers)
    server.closeWith(4401, ' unauthenticated ')
    await server.until(() => calls.close.length === 1)
    expect(calls.close[0]?.[0]).toBe('unauthenticated')
  })

  it('close() ends the connection and then tells the handlers nothing', async () => {
    // Shutdown, and a credential change, close the socket on purpose. If the
    // close came back as onClose the connector would schedule a reconnect for a
    // socket it just discarded, or after it had been told to stop.
    const { calls, handlers } = recorder()
    const socket = await open(handlers)
    socket.close()
    await server.until(() => server.closedClients === 1)
    // A frame in flight at that moment is not delivered either.
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.close).toEqual([])
  })

  it('does nothing, and does not throw, when asked to send on a closed socket', async () => {
    const { calls, handlers } = recorder()
    const socket = await open(handlers)
    server.closeWith(1011, 'bye')
    await server.until(() => calls.close.length === 1)
    expect(() => socket.subscribe('x#1', DOC)).not.toThrow()
    expect(() => socket.complete('x#1')).not.toThrow()
    expect(() => socket.close()).not.toThrow()
  })
})
