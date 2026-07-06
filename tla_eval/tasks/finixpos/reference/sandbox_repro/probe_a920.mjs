// Try card-present create against the disabled A920s; if "not enabled", try a
// reversible enable, retry, and restore. All evidence redacted-logged.
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
  console.log(s.length > 500 ? s.slice(0, 500) + '…' : s)
}
async function call(step, method, p, body) {
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
  log({ step, method, path: p, request: body ?? null, status: res.status, response: data })
  return { status: res.status, data }
}

const A920S = ['DVb6dnAtmL7EB9TA4DJPVL5s', 'DVcxJi78QfdhxrrFggdWNjJQ', 'DVvimMcA7EsEwX5ibbJV94T']
const K = randomUUID()
const mkBody = (device) => ({
  amount: 100, currency: 'USD', device, operation_key: 'CARD_PRESENT_DEBIT',
  idempotency_id: K, tags: { study: 'finixpos-gap2-sandbox-repro', order_id: 'study_repro_2' },
})

for (const d of A920S) {
  const r = await call('a920-create-disabled', 'POST', '/transfers', mkBody(d))
  if (r.status >= 200 && r.status < 300) { log({ note: 'created on disabled device?!', device: d, id: r.data?.id }); process.exit(0) }
  const msg = JSON.stringify(r.data ?? {})
  if (/not enabled|disabled/i.test(msg)) {
    // reversible enable attempt
    const en = await call('a920-enable', 'PUT', `/devices/${d}`, { enabled: true })
    if (en.status >= 200 && en.status < 300) {
      const r2 = await call('a920-create-enabled', 'POST', '/transfers', mkBody(d))
      if (r2.status >= 200 && r2.status < 300 && r2.data?.id) {
        log({ note: 'CREATED', device: d, transferId: r2.data.id, state: r2.data.state })
        // duplicate same K
        await call('a920-duplicate-same-K', 'POST', '/transfers', mkBody(d))
        await call('a920-get', 'GET', `/transfers/${r2.data.id}`)
        await call('a920-cancel', 'PUT', `/devices/${d}`, { action: 'CANCEL' })
        await new Promise((r3) => setTimeout(r3, 3000))
        await call('a920-get-after-cancel', 'GET', `/transfers/${r2.data.id}`)
        await call('a920-duplicate-after-cancel', 'POST', '/transfers', mkBody(d))
        await call('a920-tidy-cancel', 'PUT', `/devices/${d}`, { action: 'CANCEL' })
      }
      // restore disabled state
      await call('a920-restore-disabled', 'PUT', `/devices/${d}`, { enabled: false })
      process.exit(0)
    }
  }
}
log({ note: 'no A920 usable; CNP fallback required' })
