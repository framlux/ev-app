import { fileURLToPath } from 'node:url'
import path from 'node:path'
import migrate from 'node-pg-migrate'
import { getPool } from './pool.js'

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export async function runMigrations(): Promise<void> {
  const client = await getPool().connect()
  try {
    await migrate({
      dbClient: client,
      dir: migrationsDir,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: (m) => console.log(m),
    })
  } finally {
    client.release()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1) })
}
