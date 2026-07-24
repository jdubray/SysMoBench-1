// Enumerate devices under the sandbox merchant (redacted evidence).
import { readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of readFileSync('C:/Users/jjdub/code/baanbaan/Merchant/v2/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '')
}
const BASE = (env.FINIX_BASE || '').replace(/\/$/, '')
if (BASE !== 'https://finix.sandbox-payments-api.com') process.exit(2)
const AUTH = 'Basic ' + Buffer.from(`${env.FINIX_USERNAME}:${env.FINIX_PASSWORD}`).toString('base64')

async function get(p) {
  const res = await fetch(BASE + p, { headers: { Authorization: AUTH, 'Finix-Version': '2022-02-01' }, signal: AbortSignal.timeout(30000) })
  let data = null
  try { data = await res.json() } catch { }
  const entry = { method: 'GET', path: p, status: res.status, response: data }
  appendFileSync(path.join(HERE, 'step1_evidence.jsonl'), JSON.stringify(entry) + '\n')
  return entry
}

const r = await get(`/merchants/${env.FINIX_MERCHANT_ID}/devices`)
const devices = r.response?._embedded?.devices ?? []
console.log('status:', r.status, 'devices:', devices.length)
for (const d of devices) console.log(JSON.stringify({ id: d.id, model: d.model, name: d.name, enabled: d.enabled, connection: d.connection }))
