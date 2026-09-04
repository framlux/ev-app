export function GET(): Response {
	return new Response('ok', { headers: { 'content-type': 'text/plain' } })
}
