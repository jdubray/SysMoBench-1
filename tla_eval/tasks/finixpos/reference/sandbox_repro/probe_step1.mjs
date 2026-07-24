// Gap-2 sandbox reproduction — Step 1: empirical idempotency/422 validation
// against the REAL Finix sandbox. Evidence is written as redacted JSONL.
// Safety: sandbox-host hard assert; amounts <= 100 cents; credentials never logged.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENV_PATH = 'C:/Users/jjdub/code/baanbaan/Merchant/v2/.env'
const EVIDENCE = path.join(HERE, 'step1_evidence.jsonl')

const env = {}
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '')
}

const BASE = (env.FINIX_BASE || '').replace(/\/$/, '')
if (BASE !== 'https://finix.sandbox-payments-api.com') {
  console.error(`FATAL: base is not the Finix sandbox: ${BASE}`)
  process.exit(2)
}
const AUTH = 'Basic ' + Buffer.from(`${env.FINIX_USERNAME}:${env.FINIX_PASSWORD}`).toString('base64')
const DEVICES = ['DV4ZWaRMA3RASDD1Zz9ZEC4j']
const VERSION = '2022-02-01'

function log(entry) {
  const line = JSON.stringify(entry)
  appendFileSync(EVIDENCE, line + '\n')
  console.log(line.length > 600 ? line.slice(0, 600) + '…' : line)
}

async function call(step, method, p, body) {
  const url = new URL(BASE + p)
  if (url.hostname !== 'finix.sandbox-payments-api.com') throw new Error('host escape blocked')
  const started = new Date().toISOString()
  let res, data = null, text = null
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: AUTH, // never logged
        'Content-Type': 'application/json',
        'Finix-Version': VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    text = await res.text()
    try { data = JSON.parse(text) } catch { /* keep raw */ }
  } catch (e) {
    log({ step, ts: started, method, path: p, request: body ?? null, network_error: String(e) })
    return { status: 0, data: null }
  }
  log({ step, ts: started, method, path: p, request: body ?? null, status: res.status, response: data ?? text })
  return { status: res.status, data }
}

mkdirSync(HERE, { recursive: true })
log({ note: 'gap-2 sandbox reproduction step 1', started: new Date().toISOString(), base: BASE, devices: DEVICES.length })

const K = randomUUID()
const mkBody = (device) => ({
  amount: 100,
  currency: 'USD',
  device,
  operation_key: 'CARD_PRESENT_DEBIT',
  idempotency_id: K,
  tags: { study: 'finixpos-gap2-sandbox-repro', order_id: 'study_repro_1' },
})

let device = null, transferId = null, r = null
for (const d of DEVICES) {
  r = await call('1-create', 'POST', '/transfers', mkBody(d))
  if (r.status >= 200 && r.status < 300 && r.data?.id) { device = d; transferId = r.data.id; break }
  // try next device on failure
}

if (!transferId) {
  log({ note: 'no device accepted the card-present create; stopping before CNP fallback (separate script)' })
  process.exit(3)
}

log({ note: 'created', transferId, device, state: r.data?.state })

// 2. duplicate POST, same K, same device
const dup = await call('2-duplicate-same-K', 'POST', '/transfers', mkBody(device))

// 3. GET the transfer
await call('3-get', 'GET', `/transfers/${transferId}`)

// 4. cancel via device
await call('4-device-cancel', 'PUT', `/devices/${device}`, { action: 'CANCEL' })

// small settle wait, then re-GET
await new Promise((res_) => setTimeout(res_, 3000))
await call('5-get-after-cancel', 'GET', `/transfers/${transferId}`)

// 6. duplicate POST after cancellation — the emulator's 422 case
await call('6-duplicate-after-cancel', 'POST', '/transfers', mkBody(device))

// final tidy: one more device cancel in case step 6 created anything
await call('7-tidy-cancel', 'PUT', `/devices/${device}`, { action: 'CANCEL' })

log({ note: 'step 1 complete', duplicateStatusWhilePending: dup.status })
