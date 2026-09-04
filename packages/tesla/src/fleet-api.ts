const BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1'

async function get<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json() as { response: T }).response
}

export const listVehicles = (t: string) =>
  get<{ vin: string; display_name: string }[]>('/vehicles', t)

export const fleetStatus = (t: string, vins: string[]) =>
  post<{ key_paired_vins: string[] }>('/vehicles/fleet_status', t, { vins })

export const getTelemetryConfig = (t: string, vin: string) =>
  get<{ synced: boolean }>(`/vehicles/${vin}/fleet_telemetry_config`, t)

async function post<T>(path: string, accessToken: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json() as { response: T }).response
}
