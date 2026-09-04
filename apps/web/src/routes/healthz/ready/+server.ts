// Readiness must eventually reflect the database; no database exists yet, so
// this returns a static ok and Task 14 replaces the body with a real query.
export async function GET(): Promise<Response> {
	return new Response('ok', { headers: { 'content-type': 'text/plain' } })
}
