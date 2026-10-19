import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * A stand-in for Rivian's subscription endpoint, in this process, on a port the
 * operating system picks and bound to loopback. Tests never reach the network:
 * the connector's socket is pointed at `url` and everything it says is recorded
 * here.
 *
 * It speaks as much of `graphql-transport-ws` as the connector listens for, and
 * no more. It REQUIRES the subprotocol: a real server that does not hear
 * `graphql-transport-ws` refuses the upgrade, and a client that forgot to offer
 * it should fail here the way it would there, not quietly talk to a server that
 * would have taken anything.
 */
export interface FakeRivianWs {
  /** `ws://127.0.0.1:<port>`, for `openSocket`'s `url`. */
  url: string
  /** The payload of every `connection_init`, in arrival order. */
  inits: unknown[]
  /** Every `subscribe` message, as `{ id, payload }`. */
  subscribes: { id: string; payload: unknown }[]
  /** The id of every `complete` the client sent. */
  completes: string[]
  /** Every `pong` the client sent (they answer our pings). */
  pongs: number
  /** The HTTP headers of every upgrade request. */
  upgradeHeaders: IncomingHttpHeaders[]
  /** How many client connections the server has seen end. */
  closedClients: number
  /** Whether to answer `connection_init` with `connection_ack`. Settable. */
  ack: boolean
  sendNext(id: string, payload: unknown): void
  sendError(id: string, errors: unknown): void
  sendComplete(id: string): void
  sendPing(): void
  /** Send text exactly as given, for frames no honest server would send. */
  sendRaw(text: string): void
  /** Close every connected client with this code and reason text. */
  closeWith(code: number, reason: string): void
  /** Drop every connected client without a closing handshake. */
  dropClients(): void
  /** Resolve when `predicate` holds; reject after `timeoutMs`. */
  until(predicate: () => boolean, timeoutMs?: number): Promise<void>
  /** Stop listening and drop every client. */
  stop(): Promise<void>
}

export const SUBPROTOCOL = 'graphql-transport-ws'

export async function startFakeRivianWs(opts: { ack?: boolean } = {}): Promise<FakeRivianWs> {
  const clients = new Set<WebSocket>()

  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    // A 400, not ws's default 401: a refused subprotocol is a malformed
    // request, and must not look like the server saying the session is dead.
    verifyClient: (
      { req }: { req: IncomingMessage },
      done: (accepted: boolean, code?: number, message?: string) => void,
    ) => {
      const offered = String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((p) => p.trim())
      if (offered.includes(SUBPROTOCOL)) done(true)
      else done(false, 400, 'Bad Request')
    },
  })
  await new Promise<void>((resolve) => server.once('listening', resolve))

  const fake: FakeRivianWs = {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    inits: [],
    subscribes: [],
    completes: [],
    pongs: 0,
    upgradeHeaders: [],
    closedClients: 0,
    ack: opts.ack ?? true,
    sendNext: (id, payload) => broadcast({ id, type: 'next', payload }),
    sendError: (id, errors) => broadcast({ id, type: 'error', payload: errors }),
    sendComplete: (id) => broadcast({ id, type: 'complete' }),
    sendPing: () => broadcast({ type: 'ping' }),
    sendRaw(text) {
      for (const client of clients) client.send(text)
    },
    closeWith(code, reason) {
      for (const client of clients) client.close(code, reason)
    },
    dropClients() {
      for (const client of clients) client.terminate()
    },
    until(predicate, timeoutMs = 2_000) {
      return new Promise<void>((resolve, reject) => {
        const started = Date.now()
        const tick = (): void => {
          if (predicate()) return resolve()
          if (Date.now() - started > timeoutMs) return reject(new Error('fake ws: condition not met in time'))
          setTimeout(tick, 5)
        }
        tick()
      })
    },
    async stop() {
      for (const client of clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  function broadcast(message: unknown): void {
    const text = JSON.stringify(message)
    for (const client of clients) client.send(text)
  }

  server.on('connection', (socket, req) => {
    clients.add(socket)
    fake.upgradeHeaders.push(req.headers)
    socket.on('close', () => {
      clients.delete(socket)
      fake.closedClients += 1
    })
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { type?: string; id?: string; payload?: unknown }
      switch (message.type) {
        case 'connection_init':
          fake.inits.push(message.payload)
          if (fake.ack) socket.send(JSON.stringify({ type: 'connection_ack' }))
          break
        case 'subscribe':
          fake.subscribes.push({ id: String(message.id), payload: message.payload })
          break
        case 'complete':
          fake.completes.push(String(message.id))
          break
        case 'pong':
          fake.pongs += 1
          break
      }
    })
  })

  return fake
}
