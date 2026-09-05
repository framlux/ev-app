import { error } from '@sveltejs/kit'
import { ApiProblem } from './queries.js'

/**
 * Run a query helper and translate its failures into SvelteKit responses.
 *
 * queries.ts throws `ApiProblem` rather than calling `error()` so it stays
 * importable without a Kit runtime (the unit tests do exactly that) and so a
 * page load can catch a 404 and render an empty state instead of an error
 * page. This is the one place that conversion happens.
 *
 * Anything that is not an ApiProblem is rethrown untouched: a connection
 * failure is a 500 with a stack trace in the log, not a tidy JSON message
 * that makes an outage look like a client mistake.
 */
export async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ApiProblem) throw error(e.status, e.message)
    throw e
  }
}
