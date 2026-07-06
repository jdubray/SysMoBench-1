// CNP fallback: validate Finix sandbox idempotency_id duplicate semantics.
// buyer identity -> payment instrument (sandbox test card) -> transfer,
// then duplicate-POST the same idempotency_id and record exactly what returns.
import { readFileSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

function log(entry) {
  appendFileSync(path.join(HERE, 'step1_evidence.jsonl'), JSON.stringify(entry) + '\n')
  const s = JSON.stringify(entry)
  console.log(s.length > 700 ? s.slice(0, 700) + '…' : s)
}
async function call(step, method, p, body, redactBody = false) {
  let res, data = null
  try {
    res = await fetch(BASE + p, {
      method,
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', 'Finix-Version': '2022-02-01' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    })
    try { data = await res.json() } catch { }
  } catch (e) { log({ step, method, path: p, network_error: String(e) }); return { status: 0 } }
  log({ step, method, path: p, request: redactBody ? '(card details redacted)' : (body ?? null), status: res.status, response: data })
  return { status: res.status, data }
}

// 1. buyer identity
const idn = await call('cnp-1-identity', 'POST', '/identities', { entity: { first_name: 'Study', last_name: 'Repro' } })
if (!idn.data?.id) { log({ note: 'identity creation failed; stopping' }); process.exit(3) }

// 2. payment instrument from sandbox test card (Finix documented test PAN)
const pi = await call('cnp-2-instrument', 'POST', '/payment_instruments', {
  type: 'PAYMENT_CARD',
  number: '4111111111111111',
  expiration_month: 12,
  expiration_year: 2029,
  security_code: '022',
  name: 'Study Repro',
  identity: idn.data.id,
}, true)
if (!pi.data?.id) { log({ note: 'PI creation failed; stopping' }); process.exit(3) }

// 3. CNP transfer with idempotency_id K
const K = randomUUID()
const body = {
  source: pi.data.id,
  merchant: env.FINIX_MERCHANT_ID,
  amount: 100,
  currency: 'USD',
  idempotency_id: K,
  tags: { study: 'finixpos-gap2-sandbox-repro', order_id: 'study_repro_cnp' },
}
const t1 = await call('cnp-3-create', 'POST', '/transfers', body)
if (!t1.data?.id) { log({ note: 'transfer creation failed; stopping' }); process.exit(3) }
log({ note: 'transfer created', id: t1.data.id, state: t1.data.state })

// 4. duplicate POST, same K (transfer likely SUCCEEDED for CNP)
const dup = await call('cnp-4-duplicate-same-K', 'POST', '/transfers', body)

// 5. GET the original
await call('cnp-5-get', 'GET', `/transfers/${t1.data.id}`)

// 6. duplicate with same K but DIFFERENT amount (some APIs distinguish key-reuse-with-different-payload)
await call('cnp-6-duplicate-diff-amount', 'POST', '/transfers', { ...body, amount: 99 })

// 7. reverse the charge so nothing dangles (sandbox hygiene)
await call('cnp-7-reversal', 'POST', `/transfers/${t1.data.id}/reversals`, { refund_amount: 100 })

log({ note: 'cnp probe complete', duplicateStatus: dup.status })
