import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A worker that cannot start must END, so that Kubernetes restarts it.
 *
 * Startup opens the metrics server before it touches Postgres, and the
 * liveness probe is a TCP check on that port. A startup failure that only set
 * an exit code therefore left a process the open server would not let go of:
 * answering its probe, subscribed to nothing. On 2026-09-19 a node reboot
 * started ev-ingest before Postgres accepted connections, and it sat Running
 * 1/1 for six days while the broker's queue for it filled and then dropped.
 *
 * This runs the built entrypoint rather than importing it, because the
 * question is about the process — does it exit — and main.ts starts itself
 * on import. CI builds before it tests; locally, run `pnpm -r build` first.
 */
const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url))

/** Far longer than a refused connection takes; the bug is "never". */
const EXIT_WITHIN_MS = 10_000

/** A port nothing is listening on: bound by us, then released. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no TCP port bound')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

describe('worker entrypoint', () => {
  it('exits non-zero when Postgres refuses the connection at startup', async () => {
    if (!existsSync(MAIN)) throw new Error(`${MAIN} does not exist: run pnpm -r build first`)

    const child = spawn(process.execPath, [MAIN], {
      // Built from nothing rather than inherited: CI exports PGHOST for a live
      // Postgres, and this test needs the refusal.
      env: {
        PATH: process.env['PATH'],
        EV_VEHICLE_ID: 'exit-test',
        EV_USABLE_CAPACITY_KWH: '75',
        MQTT_PASSWORD: 'unused',
        METRICS_PORT: String(await closedPort()),
        PGHOST: '127.0.0.1',
        PGPORT: String(await closedPort()),
        PGUSER: 'unused',
        PGPASSWORD: 'unused',
        PGDATABASE: 'unused',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const outcome = await new Promise<number | null | 'still running'>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve('still running')
      }, EXIT_WITHIN_MS)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })

    expect(outcome).toBe(1)
    // And for the right reason: a config error also exits 1, but it fails
    // before the metrics server opens, so it could never have caught the hang.
    expect(stderr).toMatch(/ECONNREFUSED/)
  }, EXIT_WITHIN_MS + 5_000)
})
