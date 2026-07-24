/**
 * Payment reconciliation service
 *
 * Verifies that every card payment recorded locally has a corresponding settled
 * transfer in the Finix ledger.  This catches split-brain scenarios where the
 * terminal charged the customer but the server never received confirmation.
 *
 * ## Matching strategy
 *
 * 1. **Transfer ID fast-path** — if `payments.finix_transfer_id` is already
 *    populated (PAX A920 Pro flow), fetch that specific transfer from Finix and
 *    confirm its state is SUCCEEDED.  On success → `matched`; on failure → fall
 *    through to window scan.
 *
 * 2. **Window scan** — otherwise, list all Finix transfers for a ±5-minute window
 *    around `payments.created_at` and look for an exact `amount_cents` match.
 *    The first match is accepted; duplicates (two identical amounts in the window)
 *    are flagged as matched on the first hit.
 *
 * 3. **Skip rules** — non-card payments are never sent to Finix:
 *    - `payment_type = 'cash'`      → status `cash_skipped`
 *    - `payment_type = 'gift_card'` → status `gift_card_skipped`
 *    - Finix not configured         → status `no_processor`
 *
 * ## Timing
 * Each card payment is scheduled for reconciliation 60 seconds after creation
 * via `scheduleReconciliation(paymentId)`.  A periodic sweep (`startReconciliation`)
 * also re-checks any payments that were missed (e.g. server was down at T+60s).
 *
 * ## Alerts
 * Unmatched card payments trigger two side effects:
 *   - SSE `payment_alert` broadcast to all open dashboard tabs
 *   - `payment_unmatched` row in `security_events` for audit trail
 * Alerts fire only once per payment (`alerted = 1` set after first alert).
 *
 * ## Results table
 * `payment_reconciliations` has a UNIQUE constraint on `payment_id` — INSERT OR
 * REPLACE keeps only the most recent check result per payment.
 */

import { getDatabase } from '../db/connection'
import { getAPIKey } from '../crypto/api-keys'
import { listTransfers, getTransfer, getTerminalTransferStatus, findTransferByIdempotencyId } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import { broadcastToMerchant } from './sse'
import { logSecurityEvent } from './security-log'
import { logPaymentEvent, prunePaymentEvents } from './payment-log'
import { resolveTerminalVerificationForOrder, recoverOrphanedCompletedPayments } from '../workflows/terminal-payment'
import { notifyMerchant } from '../routes/push'
import { sendReceiptEmail, sendEmail } from './email'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReconciliationStatus = 'matched' | 'unmatched' | 'cash_skipped' | 'gift_card_skipped' | 'no_processor'

interface PaymentRow {
  id: string
  order_id: string
  payment_type: string
  amount_cents: number
  created_at: string
  processor: string | null
  finix_transfer_id: string | null
  transaction_id: string | null
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Prevents overlapping sweep iterations when Finix API responds slowly. */
let _sweepRunning = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Schedules a reconciliation check for one payment, 60 seconds from now.
 * Fire-and-forget — never throws.
 *
 * @param merchantId  - Internal merchant ID
 * @param paymentId   - Local payment ID (pay_xxx)
 * @param paymentType - 'card' | 'cash' — cash payments are skipped immediately
 */
export function scheduleReconciliation(
  merchantId: string,
  paymentId: string,
  paymentType: 'card' | 'cash' | 'gift_card',
): void {
  if (paymentType === 'cash' || paymentType === 'gift_card') {
    // Cash and gift card payments cannot be reconciled against Finix; record immediately.
    const status = paymentType === 'cash' ? 'cash_skipped' : 'gift_card_skipped'
    setImmediate(() =>
      writeResult(merchantId, paymentId, status, null, null, null).catch(
        (err) => console.warn(`[reconcile] ${status} write failed:`, err?.message ?? err),
      ),
    )
    return
  }

  const delayMs = Number(process.env.RECONCILE_DELAY_MS ?? 60_000)
  setTimeout(
    () =>
      runReconciliation(merchantId, paymentId).catch((err) =>
        console.warn('[reconcile] runReconciliation error:', err?.message ?? err),
      ),
    delayMs,
  )
}

// ---------------------------------------------------------------------------
// Internal (exported for direct use in tests and manual-retry endpoint)
// ---------------------------------------------------------------------------

/**
 * Loads Finix creds for the merchant and attempts to match the payment to a
 * Finix transfer.  Strategy (in order):
 *
 *   1. `finix_transfer_id` already set → instant match
 *   2. `transaction_id` set → direct `getTransfer()` lookup
 *   3. `listTransfers` ±5 min window → exact amount match
 *   4. **Last resort**: `listTransfers` ±48 hours → exact amount match
 *
 * GUARANTEED to write a result to `payment_reconciliations` — never leaves
 * a payment in "Pending check" limbo.
 */
export async function runReconciliation(merchantId: string, paymentId: string): Promise<void> {
  const db = getDatabase()

  const payment = db
    .query<PaymentRow, [string, string]>(
      `SELECT id, order_id, payment_type, amount_cents, created_at, processor,
              finix_transfer_id, transaction_id
       FROM payments WHERE id = ? AND merchant_id = ?`,
    )
    .get(paymentId, merchantId)

  if (!payment) {
    console.warn(`[reconcile] payment ${paymentId} not found for merchant ${merchantId}`)
    return
  }

  console.log(`[reconcile] checking ${paymentId}: amount=$${(payment.amount_cents / 100).toFixed(2)} processor=${payment.processor} txn_id=${payment.transaction_id ?? 'NULL'} finix_id=${payment.finix_transfer_id ?? 'NULL'}`)

  // ── Clover payments: confirmed by Clover API — no Finix lookup needed ─
  if (payment.processor === 'clover') {
    console.log(`[reconcile] ${paymentId} → processor=clover, marking matched (Clover-confirmed)`)
    await writeResult(merchantId, paymentId, 'matched', null, payment.amount_cents, payment.amount_cents)
    return
  }

  // ── Strategy 1: finix_transfer_id already set ──────────────────────────
  if (payment.finix_transfer_id) {
    console.log(`[reconcile] ${paymentId} → finix_transfer_id already set, instant match`)
    await writeResult(merchantId, paymentId, 'matched', payment.finix_transfer_id, payment.amount_cents, payment.amount_cents)
    return
  }

  // ── Load Finix credentials (needed for all remaining strategies) ───────
  const creds = await loadFinixCreds(merchantId)
  if (!creds) {
    console.warn(`[reconcile] ${paymentId} → no Finix credentials, writing no_processor`)
    await writeResult(merchantId, paymentId, 'no_processor', null, payment.amount_cents, null)
    return
  }

  // Read the existing alerted flag once before any writes so we can gate SSE
  // broadcasts correctly.  The sweep re-runs runReconciliation every 30 s for
  // unmatched payments; without this guard every sweep tick fires a
  // payment_alert SSE event for the same payment until it resolves.
  const existingRec = db
    .query<{ alerted: number }, [string]>(
      `SELECT alerted FROM payment_reconciliations WHERE payment_id = ?`,
    )
    .get(paymentId)
  const _wasAlerted = (existingRec?.alerted ?? 0) === 1

  // Wrap all Finix API calls in a top-level try/catch so we ALWAYS write
  // a result — even if the API is down, creds are wrong, or anything else
  // goes wrong.  "Pending check" (no record at all) must never persist.
  try {
    // ── Strategy 2: transaction_id set → direct lookup ─────────────────
    if (payment.transaction_id) {
      console.log(`[reconcile] ${paymentId} → trying direct getTransfer(${payment.transaction_id})`)
      try {
        const transfer = await getTransfer(creds, payment.transaction_id)
        console.log(`[reconcile] ${paymentId} → getTransfer returned state=${transfer.state} amount=${transfer.amount}`)

        if (transfer.state === 'SUCCEEDED' && transfer.amount === payment.amount_cents) {
          db.run(`UPDATE payments SET finix_transfer_id = ? WHERE id = ?`, [transfer.id, paymentId])
          await writeResult(merchantId, paymentId, 'matched', transfer.id, payment.amount_cents, transfer.amount)
          console.log(`[reconcile] ✓ ${paymentId} matched via transaction_id → ${transfer.id}`)
          return
        }
        // SUCCEEDED but amount mismatch — log and fall through
        if (transfer.state === 'SUCCEEDED') {
          console.warn(`[reconcile] ${paymentId} → transfer SUCCEEDED but amount mismatch: local=${payment.amount_cents} finix=${transfer.amount}`)
        }
        // PENDING or other state — fall through to search
        if (transfer.state === 'PENDING') {
          console.log(`[reconcile] ${paymentId} → transfer still PENDING, falling through to search`)
        }
      } catch (err) {
        console.warn(`[reconcile] ${paymentId} → getTransfer failed:`, (err as Error)?.message ?? err)
        // Fall through to listTransfers search
      }
    }

    // ── Strategy 3: ±5 min window search ─────────────────────────────────
    const paymentMs = new Date(payment.created_at.replace(' ', 'T') + 'Z').getTime()

    let narrowMatch = await searchTransfersByWindow(creds, payment, paymentMs, 5 * 60_000, 'narrow ±5min')
    if (narrowMatch) {
      if (claimTransferForPayment(db, payment, narrowMatch.id)) {
        await writeResult(merchantId, paymentId, 'matched', narrowMatch.id, payment.amount_cents, narrowMatch.amount)
        console.log(`[reconcile] ✓ ${paymentId} matched via narrow window → ${narrowMatch.id}`)
        return
      }
      console.warn(`[reconcile] ${paymentId} → ${narrowMatch.id} was claimed concurrently — continuing search`)
    }

    // ── Strategy 4: LAST RESORT — ±48 hour window ───────────────────────
    // For payments where the narrow window missed (e.g. old payments,
    // timing skew).  The user says: "the amount matches, that's all we need."
    console.log(`[reconcile] ${paymentId} → narrow window found nothing, trying ±48h last resort`)
    let wideMatch = await searchTransfersByWindow(creds, payment, paymentMs, 48 * 60 * 60_000, 'wide ±48h')
    if (wideMatch) {
      if (claimTransferForPayment(db, payment, wideMatch.id)) {
        await writeResult(merchantId, paymentId, 'matched', wideMatch.id, payment.amount_cents, wideMatch.amount)
        console.log(`[reconcile] ✓ ${paymentId} matched via LAST RESORT wide window → ${wideMatch.id}`)
        return
      }
      console.warn(`[reconcile] ${paymentId} → ${wideMatch.id} was claimed concurrently — falling through to unmatched`)
    }

    // ── No match at all ──────────────────────────────────────────────────
    // If the processor is unknown (null) and no Finix-specific identifiers
    // exist, this payment was likely recorded via the old dashboard modal before
    // server-side Clover recording was added.  We cannot reconcile it against
    // Finix — use 'no_processor' to avoid a false alarm.
    if (!payment.processor) {
      await writeResult(merchantId, paymentId, 'no_processor', null, payment.amount_cents, null)
      console.warn(`[reconcile] ${paymentId} → processor unknown, no Finix match — marking no_processor (likely non-Finix payment via old modal)`)
      return
    }

    await writeResult(merchantId, paymentId, 'unmatched', null, payment.amount_cents, null)
    console.warn(`[reconcile] ⚠ ${paymentId} UNMATCHED — no Finix transfer for $${(payment.amount_cents / 100).toFixed(2)} in any window`)
    logPaymentEvent('reconciliation_unmatched', {
      merchantId, orderId: payment.order_id, paymentId, amountCents: payment.amount_cents,
      level: 'warn',
      message: `No Finix transfer found for $${(payment.amount_cents / 100).toFixed(2)} in ±5min or ±48h window`,
    })

    // Only fire SSE + security log on the FIRST unmatched result for this
    // payment.  The 30 s sweep retries all unmatched payments indefinitely, so
    // without this guard every tick would spam payment_alert events.
    if (!_wasAlerted) {
      broadcastToMerchant(merchantId, 'payment_alert', {
        paymentId,
        orderId:     payment.order_id,
        amountCents: payment.amount_cents,
        type:        'unmatched',
      })

      logSecurityEvent('payment_unmatched', {
        merchantId,
        extra: {
          paymentId,
          orderId:     payment.order_id,
          amountCents: payment.amount_cents,
        },
      })
    }
  } catch (err) {
    // SAFETY NET: if ANYTHING above throws (Finix API down, DB error,
    // whatever), write 'unmatched' so the payment never stays "Pending check".
    console.error(`[reconcile] ${paymentId} UNEXPECTED ERROR — writing unmatched as safety net:`, (err as Error)?.message ?? err)
    try {
      await writeResult(merchantId, paymentId, 'unmatched', null, payment.amount_cents, null)
      if (!_wasAlerted) {
        broadcastToMerchant(merchantId, 'payment_alert', {
          paymentId,
          orderId:     payment.order_id,
          amountCents: payment.amount_cents,
          type:        'unmatched',
        })
      }
    } catch (writeErr) {
      console.error(`[reconcile] ${paymentId} CRITICAL — even writeResult failed:`, (writeErr as Error)?.message ?? writeErr)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Loads Finix credentials for a merchant.  Returns null if not configured.
 */
async function loadFinixCreds(merchantId: string): Promise<FinixCredentials | null> {
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  if (!apiPassword) return null

  const db = getDatabase()
  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'
       LIMIT 1`,
    )
    .get(merchantId)

  const parts = keyRow?.pos_merchant_id?.split(':') ?? []
  if (parts.length !== 3) return null
  const [apiUsername, applicationId, finixMerchantId] = parts

  const merchantRow = db
    .query<{ finix_sandbox: number }, [string]>(`SELECT finix_sandbox FROM merchants WHERE id = ?`)
    .get(merchantId)
  const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

  return { apiUsername, applicationId, merchantId: finixMerchantId, apiPassword, sandbox }
}

/**
 * True when another payment row (or another order) already owns this Finix
 * transfer. Amount-window matching must never claim a transfer twice: two
 * same-amount charges in one window would otherwise both "match" the same
 * transfer, marking a genuinely uncharged payment (or unpaid order) as paid
 * and silencing the alert that should have fired.
 *
 * `exceptPaymentsOfOrder` exempts payments rows belonging to a given order —
 * used by the ORDER reconciliation path, where a payments row of the same
 * order holding the transfer just means the charge is already recorded.
 */
function isTransferClaimed(
  db: ReturnType<typeof getDatabase>,
  transferId: string,
  opts: { exceptPaymentId?: string; exceptOrderId?: string; exceptPaymentsOfOrder?: string } = {},
): boolean {
  // (COALESCE(order_id,'') != ? OR ? = '') — when no exceptPaymentsOfOrder is
  // given, the second disjunct is always true and no rows are exempted.
  const exceptOrder = opts.exceptPaymentsOfOrder ?? ''
  const byPayment = db
    .query<{ id: string }, [string, string, string, string]>(
      `SELECT id FROM payments
        WHERE finix_transfer_id = ?
          AND id != ?
          AND (COALESCE(order_id, '') != ? OR ? = '')
        LIMIT 1`,
    )
    .get(transferId, opts.exceptPaymentId ?? '', exceptOrder, exceptOrder)
  if (byPayment) return true
  const byOrder = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM orders WHERE payment_transfer_id = ? AND id != ? LIMIT 1`,
    )
    .get(transferId, opts.exceptOrderId ?? '')
  return byOrder !== null
}

/**
 * Atomically links a transfer to a payment — refuses when any other payment
 * row or another order already owns it. The NOT EXISTS guards close the
 * microtask race between the window-search claim check and this write (two
 * same-amount reconciliations awaiting Finix concurrently).
 */
function claimTransferForPayment(
  db: ReturnType<typeof getDatabase>,
  payment: PaymentRow,
  transferId: string,
): boolean {
  const res = db.run(
    `UPDATE payments SET finix_transfer_id = ?
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM payments p2 WHERE p2.finix_transfer_id = ? AND p2.id != ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM orders o WHERE o.payment_transfer_id = ? AND o.id != ?
        )`,
    [transferId, payment.id, transferId, payment.id, transferId, payment.order_id ?? ''],
  )
  return res.changes > 0
}

/**
 * Searches Finix transfers within a time window for an exact amount match.
 * Returns the best match (closest in time) or null.
 */
async function searchTransfersByWindow(
  creds: FinixCredentials,
  payment: PaymentRow,
  paymentMs: number,
  windowMs: number,
  label: string,
): Promise<{ id: string; amount: number } | null> {
  const fromIso = new Date(paymentMs - windowMs).toISOString()
  const toIso   = new Date(paymentMs + windowMs).toISOString()

  let transfers
  try {
    transfers = await listTransfers(creds, { fromIso, toIso, limit: 200 })
    console.log(`[reconcile] ${payment.id} ${label}: ${transfers.length} transfers found`)
  } catch (err) {
    console.warn(`[reconcile] ${payment.id} ${label} listTransfers failed:`, (err as Error)?.message ?? err)
    return null
  }

  // Find SUCCEEDED transfers with exact amount match
  const amountMatches = transfers.filter(
    (t) => t.state === 'SUCCEEDED' && t.amount === payment.amount_cents,
  )

  // M-9: drop transfers another payment or order already owns — a $25
  // transfer can only ever settle ONE $25 payment.
  const db = getDatabase()
  const succeeded = amountMatches.filter(
    (t) => !isTransferClaimed(db, t.id, { exceptPaymentId: payment.id, exceptOrderId: payment.order_id }),
  )
  if (succeeded.length < amountMatches.length) {
    console.log(
      `[reconcile] ${payment.id} ${label}: excluded ${amountMatches.length - succeeded.length} ` +
      `amount match(es) already linked to another payment/order`,
    )
  }

  if (succeeded.length === 0) {
    // Log what we DID find for diagnosis
    const states = transfers.reduce<Record<string, number>>((acc, t) => {
      acc[t.state] = (acc[t.state] ?? 0) + 1
      return acc
    }, {})
    console.log(`[reconcile] ${payment.id} ${label}: 0 claimable amount matches for $${(payment.amount_cents / 100).toFixed(2)}, states: ${JSON.stringify(states)}`)
    return null
  }

  // Pick closest to recorded time
  let best = succeeded[0]
  if (succeeded.length > 1) {
    best = succeeded.reduce((prev, t) => {
      const diffPrev = Math.abs(new Date(prev.createdAt).getTime() - paymentMs)
      const diffT    = Math.abs(new Date(t.createdAt).getTime() - paymentMs)
      return diffT < diffPrev ? t : prev
    })
  }

  return { id: best.id, amount: best.amount }
}

// ---------------------------------------------------------------------------
// Online order reconciliation (Finix redirect flow)
// ---------------------------------------------------------------------------

/**
 * Schedules a reconciliation check for an *online* order 60 seconds after
 * the payment return is processed.
 *
 * Called only when the checkout form state is COMPLETED but no transfer ID
 * could be resolved at the time (rare edge case).  On success, writes the
 * transfer ID back to `orders.payment_transfer_id` and broadcasts SSE.
 *
 * @param merchantId  - Internal merchant ID
 * @param orderId     - The order whose payment could not be verified
 * @param amountCents - Expected charge amount in cents
 */
export function scheduleOrderReconciliation(
  merchantId: string,
  orderId: string,
  amountCents: number,
  customDelayMs?: number,
): void {
  const delayMs = customDelayMs ?? Number(process.env.RECONCILE_DELAY_MS ?? 60_000)
  setTimeout(
    () =>
      runOrderReconciliation(merchantId, orderId, amountCents, 0).catch((err) =>
        console.warn('[reconcile] runOrderReconciliation error:', err?.message ?? err),
      ),
    delayMs,
  )
}

/**
 * Attempts to recover the Finix transfer ID for an online order whose checkout
 * form was COMPLETED but had no transfer ID embedded at payment time, OR whose
 * form state was still PENDING when /payment-result was first called (Finix race).
 *
 * Strategy (in order):
 *   1. Re-poll the checkout form — Finix often embeds the transfer within a
 *      few seconds of COMPLETED even when it wasn't there immediately.
 *   2. Window scan ±15 min around order creation/confirmation time.
 *
 * On success:
 *   - If the order is still 'pending_payment' (Finix race case), atomically
 *     confirms it: status → 'submitted', fires push + SSE + receipt email.
 *   - If already confirmed, just backfills payment_transfer_id.
 *
 * On failure → logs a warning but does NOT broadcast 'unmatched' — the order
 * is already correctly marked paid and the payments tab shows it as matched
 * via the SQL CASE expression; a false alarm would confuse staff.
 */
/** Escalating retry delays after a failed reconciliation attempt (ms). */
const ORDER_RECONCILE_RETRY_DELAYS_MS = [120_000, 300_000] // T+2min, T+5min

async function runOrderReconciliation(
  merchantId: string,
  orderId: string,
  amountCents: number,
  attempt = 0,
): Promise<void> {
  const result = await _attemptOrderResolution(merchantId, orderId, amountCents)
  if (result.outcome !== 'pending') return

  // ── No match found ──────────────────────────────────────────────────────
  // For already-confirmed orders the payments tab shows them as matched via
  // the SQL CASE expression — do NOT broadcast 'unmatched' (false alarm).
  // For pending_payment orders: schedule escalating retries (attempt 0 → T+2min,
  // attempt 1 → T+5min). After attempt 2 the orphan monitor takes over.
  console.warn(
    `[reconcile] order ${orderId} transfer not recoverable (attempt ${attempt}) — ` +
    `$${(amountCents / 100).toFixed(2)} not found in Finix ±15min window. ` +
    `Status: ${result.status ?? 'unknown'}.`,
  )
  logSecurityEvent('payment_unmatched', {
    merchantId,
    extra: { orderId, amountCents, source: 'online', note: 'transfer_id_not_recovered', status: result.status, attempt },
  })

  if (result.status === 'pending_payment' && attempt < ORDER_RECONCILE_RETRY_DELAYS_MS.length) {
    const nextDelay = ORDER_RECONCILE_RETRY_DELAYS_MS[attempt]
    console.log(`[reconcile] order ${orderId} — scheduling retry attempt ${attempt + 1} in ${nextDelay / 1000}s`)
    setTimeout(
      () => runOrderReconciliation(merchantId, orderId, amountCents, attempt + 1)
        .catch(err => console.warn('[reconcile] runOrderReconciliation retry error:', err?.message ?? err)),
      nextDelay,
    )
  }
}

/**
 * Synchronous payment verification for an online order. Used by
 * `/submit-pending` (policy 2026-06-12: an order must NEVER reach the kitchen
 * as if paid when it isn't — incident ord_926ec25612b8b549: AVS-declined
 * payment, order prepared and picked up, $38.64 never collected).
 *
 * Returns:
 *   'confirmed' — payment verified (order promoted to submitted if it was
 *                 still pending_payment) or order already past pending+paid.
 *   'failed'    — a FAILED Finix transfer matches this order and no successful
 *                 one exists. Policy 2026-06-15: the order is NOT cancelled —
 *                 it is kept, marked `payment_failed=1`, and surfaced in the
 *                 POS as UNPAID with cash/card pay buttons. The customer is
 *                 shown a retry screen and may also pay online again.
 *   'pending'   — outcome genuinely unknown (Finix unreachable / transfer
 *                 not visible yet). Order left in pending_payment.
 */
export async function verifyOrderPaymentNow(
  merchantId: string,
  orderId: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  const db = getDatabase()
  const row = db
    .query<{ status: string; total_cents: number; payment_failed: number }, [string, string]>(
      `SELECT status, total_cents, COALESCE(payment_failed, 0) AS payment_failed
       FROM orders WHERE id = ? AND merchant_id = ?`,
    )
    .get(orderId, merchantId)
  if (!row) return 'pending'
  if (row.status !== 'pending_payment') {
    // Already resolved: cancelled OR a kept-but-unpaid (payment_failed) order
    // both mean "not paid"; anything else is confirmed/paid.
    if (row.status === 'cancelled' || row.payment_failed === 1) return 'failed'
    return 'confirmed'
  }
  const result = await _attemptOrderResolution(merchantId, orderId, row.total_cents)
  return result.outcome
}

/**
 * Core resolution step shared by the retry chain and the synchronous
 * `/submit-pending` check: re-poll the checkout form, window-scan Finix for a
 * SUCCEEDED transfer (confirm) or — failing that — a FAILED transfer of the
 * same amount (cancel the order: the charge was declined).
 */
async function _attemptOrderResolution(
  merchantId: string,
  orderId: string,
  amountCents: number,
): Promise<{ outcome: 'confirmed' | 'failed' | 'pending'; status?: string }> {
  const db = getDatabase()

  const order = db
    .query<{
      created_at: string
      updated_at: string
      status: string
      pickup_code: string | null
      customer_name: string
      total_cents: number
      payment_transfer_id: string | null
      payment_checkout_form_id: string | null
    }, [string, string]>(
      `SELECT created_at, updated_at, status, pickup_code, customer_name, total_cents,
              payment_transfer_id, payment_checkout_form_id
       FROM orders WHERE id = ? AND merchant_id = ?`,
    )
    .get(orderId, merchantId)

  if (!order) return { outcome: 'pending' }
  if (order.payment_transfer_id) return { outcome: 'confirmed', status: order.status }   // already resolved

  const creds = await loadFinixCreds(merchantId)
  if (!creds) return { outcome: 'pending', status: order.status }

  // ── Strategy 1: re-poll the checkout form ──────────────────────────────
  // Finix often embeds the transfer ID within seconds of COMPLETED even when
  // it wasn't available at the moment the customer was redirected back.
  if (order.payment_checkout_form_id) {
    try {
      const { getTransferIdFromCheckoutForm } = await import('../adapters/finix')
      const result = await getTransferIdFromCheckoutForm(creds, order.payment_checkout_form_id)
      if (result.transferId) {
        console.log(`[reconcile] ✓ order ${orderId} matched via checkout form re-poll → ${result.transferId}`)
        if (await _confirmOrderPayment(merchantId, orderId, result.transferId, order)) {
          return { outcome: 'confirmed', status: order.status }
        }
        // Claim lost to a concurrent order — fall through to the window scan.
      }
    } catch (err) {
      console.warn('[reconcile] order checkout form re-poll failed:', (err as Error)?.message ?? err)
    }
  }

  // ── Strategy 2: window scan around payment confirmation time ────────────
  // For pending_payment orders use created_at (no updated_at to anchor on);
  // for already-confirmed orders use updated_at (when status changed to 'submitted').
  const anchorMs = new Date(
    (order.status === 'pending_payment' ? order.created_at : (order.updated_at ?? order.created_at))
      .replace(' ', 'T') + 'Z'
  ).getTime()
  const windowStart = new Date(anchorMs - 15 * 60_000).toISOString()
  const windowEnd   = new Date(anchorMs + 15 * 60_000).toISOString()

  let transfers
  try {
    transfers = await listTransfers(creds, { fromIso: windowStart, toIso: windowEnd, limit: 50 })
  } catch (err) {
    console.warn('[reconcile] order listTransfers failed:', (err as Error)?.message ?? err)
    return { outcome: 'pending', status: order.status }
  }

  // M-9: a transfer already linked to another payment or order must never
  // confirm THIS order — with amount-only matching, an abandoned $25
  // pending_payment order could otherwise be falsely confirmed (push +
  // receipt + marked paid) off a different customer's $25 charge. Payments
  // rows belonging to this same order are fine: that's this order's charge.
  const succeeded = transfers.filter(
    (t) => t.state === 'SUCCEEDED' && t.amount === amountCents
        && !isTransferClaimed(db, t.id, { exceptOrderId: orderId, exceptPaymentsOfOrder: orderId }),
  )

  let bestMatch = succeeded[0] ?? null
  if (succeeded.length > 1) {
    bestMatch = succeeded.reduce((best, t) => {
      const dBest = Math.abs(new Date(best.createdAt).getTime() - anchorMs)
      const dT    = Math.abs(new Date(t.createdAt).getTime()    - anchorMs)
      return dT < dBest ? t : best
    })
  }

  if (bestMatch) {
    console.log(`[reconcile] ✓ order ${orderId} matched via window scan → ${bestMatch.id}`)
    if (await _confirmOrderPayment(merchantId, orderId, bestMatch.id, order)) {
      return { outcome: 'confirmed', status: order.status }
    }
    // Matched transfer was claimed by another order between the scan and the
    // write — treat as unmatched and fall through (next retry's isTransferClaimed
    // filter will exclude it, converging to the orphan alert).
    console.warn(`[reconcile] order ${orderId} — matched transfer ${bestMatch.id} already claimed elsewhere; staying unmatched`)
  }

  // ── FAILED-transfer detection ────────────────────────────────────────────
  // No successful charge exists, but a declined one of the same amount does
  // (AVS / risk rules / issuer decline). Policy 2026-06-15: do NOT cancel —
  // keep the order, flag it UNPAID (payment_failed=1), and surface it in the
  // POS with cash/card pay buttons so staff can collect on pickup. The
  // customer is shown a retry screen and may also pay online again. (Cancelling
  // used to wipe the customer's cart via the 'cancelled' poll handler and lose
  // the order entirely — the 2026-06-15 report.)
  const failed = transfers.filter((t) => t.state === 'FAILED' && t.amount === amountCents)
  if (failed.length > 0) {
    const didMark = await _markOrderPaymentFailed(merchantId, orderId, order)
    // didMark false → a concurrent confirm already paid it; treat as confirmed.
    return { outcome: didMark ? 'failed' : 'confirmed', status: order.status }
  }

  return { outcome: 'pending', status: order.status }
}

/**
 * Marks an online order whose charge FAILED at the processor as UNPAID and
 * keeps it (policy 2026-06-15 — do NOT cancel). The order is promoted to
 * 'submitted' so it appears in the POS active queue (staff fire it to the
 * kitchen with the normal Accept control — no silent auto-print), flagged
 * `payment_failed=1` with no recorded payment, so the board shows an UNPAID
 * badge + cash/card pay buttons. The customer keeps their cart and is shown a
 * retry screen; they may also pay online again.
 *
 * Atomic on status so a concurrent confirmation always wins (then returns
 * false → caller treats it as confirmed). Idempotent if already flagged.
 */
async function _markOrderPaymentFailed(
  merchantId: string,
  orderId: string,
  order: { pickup_code: string | null; customer_name: string; total_cents: number },
): Promise<boolean> {
  const db = getDatabase()
  const marked = db
    .query<{ id: string }, [string]>(
      `UPDATE orders
       SET status = 'submitted',
           payment_method = NULL,
           paid_amount_cents = 0,
           payment_transfer_id = NULL,
           payment_failed = 1,
           payment_note = '⚠ PAYMENT FAILED — card declined. NOT paid. Collect in person (Pay buttons) or the customer may retry online.',
           updated_at = datetime('now')
       WHERE id = ? AND status IN ('pending_payment', 'submitted')
         AND payment_transfer_id IS NULL
         AND COALESCE(paid_amount_cents, 0) = 0
       RETURNING id`,
    )
    .get(orderId)
  if (!marked) return false   // already paid/confirmed by a concurrent path

  console.log(`[reconcile] ⚠ order ${orderId} payment FAILED — kept as UNPAID, shown in POS for in-person collection / online retry`)
  logSecurityEvent('payment_unmatched', {
    merchantId,
    extra: { orderId, amountCents: order.total_cents, source: 'online', note: 'transfer_failed_order_kept_unpaid' },
  })

  // Surface it on the board (new card) + clear/raise the dashboard payment alert.
  broadcastToMerchant(merchantId, 'new_order', {
    orderId,
    pickupCode:   order.pickup_code,
    customerName: order.customer_name,
    totalCents:   order.total_cents,
    paymentNote:  'PAYMENT FAILED — unpaid',
  })
  broadcastToMerchant(merchantId, 'payment_alert', {
    orderId, amountCents: order.total_cents, type: 'failed',
  })
  notifyMerchant(merchantId, {
    title: `Unpaid order — payment failed — ${order.pickup_code ?? orderId}`,
    body:  `${order.customer_name} · $${(order.total_cents / 100).toFixed(2)} — collect in person or customer retries`,
    data:  { type: 'order_payment_failed', orderId, pickupCode: order.pickup_code ?? '' },
  }).catch(err => console.warn('[reconcile] payment-failed notify failed for order', orderId, err?.message ?? err))
  return true
}

/**
 * Completes reconciliation for an online order once a transfer ID is known.
 *
 * - If the order is still 'pending_payment' (Finix race case): atomically
 *   transitions to 'submitted' and fires merchant push + SSE + receipt email,
 *   exactly as /payment-result would have done.
 * - If the order is already confirmed (normal reconcile path): just backfills
 *   payment_transfer_id without re-notifying the merchant.
 *
 * Always broadcasts 'payment_alert resolved' so the dashboard payments tab
 * can show the matched transfer ID without a full page reload.
 */
/**
 * Returns true when THIS order now owns the transfer (freshly confirmed, or
 * already confirmed by a concurrent path). Returns false when the transfer was
 * claimed by another order — the caller must then treat this order as still
 * unmatched.
 */
async function _confirmOrderPayment(
  merchantId: string,
  orderId: string,
  transferId: string,
  order: {
    status: string
    pickup_code: string | null
    customer_name: string
    total_cents: number
  },
): Promise<boolean> {
  const db = getDatabase()

  if (order.status === 'pending_payment') {
    // Atomically confirm AND claim the transfer. The NOT EXISTS guards close
    // the microtask race between the window-search claim check
    // (isTransferClaimed — a read) and this write: two same-amount
    // pending_payment orders whose reconciliation timers fire in the same tick
    // would both pass the read and, without these guards, both book the SAME
    // transfer (one charge → two confirmed orders → two kitchen tickets). The
    // submit-pending path (verifyOrderPaymentNow) and the scheduled retry are
    // independent entry points into this confirm, so the race is real. Mirrors
    // claimTransferForPayment on the payments path (M-9).
    const confirmed = db
      .query<{ id: string }, [string, string, string, string, string]>(
        `UPDATE orders
         SET status = 'submitted', payment_method = 'card',
             paid_amount_cents = total_cents, payment_transfer_id = ?,
             updated_at = datetime('now')
         WHERE id = ? AND status = 'pending_payment'
           AND NOT EXISTS (SELECT 1 FROM payments p  WHERE p.finix_transfer_id  = ?)
           AND NOT EXISTS (SELECT 1 FROM orders   o2 WHERE o2.payment_transfer_id = ? AND o2.id != ?)
         RETURNING id`,
      )
      .get(transferId, orderId, transferId, transferId, orderId)

    if (confirmed) {
      console.log(`[reconcile] order ${orderId} confirmed from pending_payment → submitted via reconciliation`)

      notifyMerchant(merchantId, {
        title: `Order paid — ${order.pickup_code ?? orderId}`,
        body:  `${order.customer_name} · $${(order.total_cents / 100).toFixed(2)}`,
        data:  { type: 'order_paid', orderId, pickupCode: order.pickup_code ?? '' },
      }).catch(err => console.warn('[reconcile] merchant notify failed for order', orderId, err?.message ?? err))

      broadcastToMerchant(merchantId, 'new_order', {
        orderId,
        pickupCode:   order.pickup_code,
        customerName: order.customer_name,
        totalCents:   order.total_cents,
      })

      sendReceiptEmail(merchantId, orderId)
        .catch(err => console.warn('[reconcile] receipt email failed for order', orderId, err?.message ?? err))

      broadcastToMerchant(merchantId, 'payment_alert', {
        orderId, amountCents: order.total_cents, type: 'resolved', transferId,
      })
      return true
    }

    // UPDATE didn't fire — two possibilities:
    //   (a) a concurrent /payment-result already confirmed THIS order, or
    //   (b) another order won the same transfer (the race the guards prevent).
    // Re-read to distinguish: if this order is now confirmed and carries a
    // transfer, it's (a) → success (no re-notify). Otherwise (b) → this order
    // stays unconfirmed and the caller keeps it pending.
    const fresh = db
      .query<{ status: string; payment_transfer_id: string | null }, [string]>(
        `SELECT status, payment_transfer_id FROM orders WHERE id = ?`,
      )
      .get(orderId)
    if (fresh && fresh.status !== 'pending_payment' && fresh.payment_transfer_id !== null) {
      return true
    }
    console.warn(`[reconcile] order ${orderId} could not claim transfer ${transferId} — already owned by another order/payment`)
    return false
  }

  // Already confirmed (normal reconcile path) OR a kept-unpaid order the
  // customer just retried online and paid. Backfill the transfer, clear the
  // payment-failed flag + note, and record the amount — but only if no other
  // order/payment owns this transfer.
  const res = db.run(
    `UPDATE orders
        SET payment_transfer_id = ?, payment_note = NULL,
            payment_failed = 0, payment_method = 'card',
            paid_amount_cents = CASE WHEN COALESCE(paid_amount_cents, 0) = 0 THEN total_cents ELSE paid_amount_cents END
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM payments p  WHERE p.finix_transfer_id  = ?)
        AND NOT EXISTS (SELECT 1 FROM orders   o2 WHERE o2.payment_transfer_id = ? AND o2.id != ?)`,
    [transferId, orderId, transferId, transferId, orderId],
  )
  if (res.changes > 0) {
    // Trigger a dashboard reload so the payment_note badge is removed immediately
    broadcastToMerchant(merchantId, 'order_updated', { orderId })
  }
  // The order is already confirmed regardless of whether the backfill landed.
  broadcastToMerchant(merchantId, 'payment_alert', {
    orderId, amountCents: order.total_cents, type: 'resolved', transferId,
  })
  return true
}

// ---------------------------------------------------------------------------
// Online payment orphan monitor — alert on alignment failures
// ---------------------------------------------------------------------------

/**
 * Sends an alert to the merchant when an online order's payment has not been
 * confirmed after all reconciliation retries.  Marks `payment_alert_sent_at`
 * before sending to prevent duplicate alerts.
 */
async function sendPaymentAlignmentAlert(
  merchantId: string,
  orderId: string,
  order: { total_cents: number; pickup_code: string | null; customer_name: string },
): Promise<void> {
  const db = getDatabase()

  // Mark sent FIRST — prevents duplicate alerts even if email/push fails
  db.run(`UPDATE orders SET payment_alert_sent_at = datetime('now') WHERE id = ?`, [orderId])

  const merchantRow = db
    .query<{ receipt_email_from: string | null; business_name: string }, [string]>(
      `SELECT receipt_email_from, business_name FROM merchants WHERE id = ?`,
    )
    .get(merchantId)

  const subject = `[Action Required] Online payment not confirmed — Order ${order.pickup_code ?? orderId}`
  const amount  = `$${(order.total_cents / 100).toFixed(2)}`
  const text = [
    `An online payment was received but could not be automatically confirmed.`,
    ``,
    `Order:    ${order.pickup_code ?? orderId}`,
    `Customer: ${order.customer_name}`,
    `Amount:   ${amount}`,
    ``,
    `The card was charged by Finix but the order has not been marked received.`,
    ``,
    `Recommended action:`,
    `  1. Check your Finix dashboard for a transfer of ${amount}`,
    `  2. If found, manually confirm the order in your dashboard`,
    `  3. Contact the customer to confirm their order is being prepared`,
    ``,
    `Order ID: ${orderId}`,
  ].join('\n')

  if (merchantRow?.receipt_email_from) {
    // Send self-alert: from receipt_email_from → to receipt_email_from
    sendEmail({ to: merchantRow.receipt_email_from, subject, text })
      .then(() => console.log(`[orphan-monitor] alert email sent for order ${orderId}`))
      .catch(err => console.warn('[orphan-monitor] alert email failed:', err?.message ?? err))
  }

  // Belt-and-suspenders: also push to the merchant dashboard
  notifyMerchant(merchantId, {
    title: `Payment alert: Order ${order.pickup_code ?? orderId}`,
    body:  `${amount} charged but not confirmed. Check Finix dashboard.`,
    data:  { type: 'payment_alignment_alert', orderId },
  }).catch(err => console.warn('[orphan-monitor] push notify failed:', err?.message ?? err))

  logSecurityEvent('payment_alignment_failed', {
    merchantId,
    extra: { orderId, amountCents: order.total_cents, pickupCode: order.pickup_code },
  })

  console.warn(
    `[orphan-monitor] ⚠ ALIGNMENT FAILED — order ${orderId} (${order.customer_name}, ${amount}): ` +
    `alert sent, manual intervention required`,
  )
}

/**
 * Scans every 5 minutes for online orders whose Finix checkout form was created
 * but never confirmed.  Orders that are still pending_payment after 15 minutes
 * get one final reconciliation attempt, then an alert email + push if still stuck.
 *
 * @returns cleanup function that cancels the background timer
 */
export function startOnlinePaymentOrphanMonitor(): () => void {
  const THRESHOLD_MINUTES = 15
  const SWEEP_MS          = 5 * 60_000

  const runSweep = async () => {
    const db = getDatabase()

    const orphans = db
      .query<{
        id: string
        merchant_id: string
        total_cents: number
        pickup_code: string | null
        customer_name: string
      }, []>(
        `SELECT id, merchant_id, total_cents, pickup_code, customer_name
         FROM orders
         WHERE payment_checkout_form_id IS NOT NULL
           AND status = 'pending_payment'
           AND payment_alert_sent_at IS NULL
           AND created_at <= datetime('now', '-${THRESHOLD_MINUTES} minutes')`,
      )
      .all()

    if (orphans.length === 0) return

    console.log(`[orphan-monitor] ${orphans.length} unresolved online payment(s) after ${THRESHOLD_MINUTES} min`)

    for (const order of orphans) {
      // One final reconciliation attempt before alerting (attempt = 99 prevents
      // further auto-rescheduling inside runOrderReconciliation)
      try {
        await runOrderReconciliation(order.merchant_id, order.id, order.total_cents, 99)
      } catch (err) {
        console.warn('[orphan-monitor] final reconciliation attempt failed:', err?.message ?? err)
      }

      // Re-read status — reconciliation may have confirmed it
      const fresh = db
        .query<{ status: string }, [string]>(`SELECT status FROM orders WHERE id = ?`)
        .get(order.id)

      if (!fresh || fresh.status !== 'pending_payment') {
        console.log(`[orphan-monitor] order ${order.id} resolved by final reconciliation`)
        continue
      }

      await sendPaymentAlignmentAlert(order.merchant_id, order.id, order)
    }
  }

  // First sweep starts after 60 s (server may still be warming up)
  const initial  = setTimeout(() => runSweep().catch(err => console.warn('[orphan-monitor] sweep error:', err?.message ?? err)), 60_000)
  const interval = setInterval(() => runSweep().catch(err => console.warn('[orphan-monitor] sweep error:', err?.message ?? err)), SWEEP_MS)

  return () => {
    clearTimeout(initial)
    clearInterval(interval)
  }
}

// ---------------------------------------------------------------------------
// Background sweep — periodic catch-up for unreconciled payments
// ---------------------------------------------------------------------------

/** How often to scan for unreconciled card payments (30 seconds). */
const SWEEP_INTERVAL_MS = 30_000

/**
 * Finds every card payment that has no reconciliation record OR is marked
 * 'unmatched' and re-runs `runReconciliation`.
 *
 * This catches:
 *   - Payments whose 60 s timer was lost to a server crash/restart
 *   - Payments that failed due to Finix API errors (now retried)
 *   - Payments that were PENDING on first check but have since settled
 *
 * The INSERT OR REPLACE in `writeResult` is idempotent, so re-checking
 * an already-reconciled payment is a safe no-op.
 */
async function sweepUnreconciled(): Promise<void> {
  const db = getDatabase()

  // 1. Payments with no reconciliation record at all ("Pending check")
  const noRecord = db
    .query<{ id: string; merchant_id: string }, []>(
      `SELECT p.id, p.merchant_id FROM payments p
       LEFT JOIN payment_reconciliations r ON r.payment_id = p.id
       WHERE p.payment_type = 'card' AND r.id IS NULL`,
    )
    .all()

  // 2. Payments marked 'unmatched' — retry ALL of them, not just those
  //    with transaction_id.  The wide ±48h last-resort search may succeed
  //    even when transaction_id is NULL.
  const unmatched = db
    .query<{ id: string; merchant_id: string }, []>(
      `SELECT p.id, p.merchant_id FROM payments p
       JOIN payment_reconciliations r ON r.payment_id = p.id
       WHERE p.payment_type = 'card'
         AND r.status = 'unmatched'`,
    )
    .all()

  const seen = new Set<string>()
  const all = [...noRecord, ...unmatched].filter(p => {
    if (seen.has(p.id)) return false
    seen.add(p.id)
    return true
  })

  if (all.length === 0) return

  console.log(`[reconcile] sweep: ${all.length} unreconciled payment(s) (${noRecord.length} no-record, ${unmatched.length} unmatched)`)
  for (const p of all) {
    await runReconciliation(p.merchant_id, p.id).catch((err) =>
      console.warn('[reconcile] sweep error:', err?.message ?? err),
    )
  }
}

/**
 * Recovers orphaned terminal sales — payments that succeeded on Finix but
 * were never recorded locally (e.g. client timeout, crash, network error).
 *
 * Scans `pending_terminal_sales` rows older than 2 minutes, checks their
 * status on Finix, and auto-creates a payment record if SUCCEEDED.
 */
export async function sweepOrphanedTerminalSales(): Promise<void> {
  const db = getDatabase()

  // Two flavours of pending rows:
  //   - transfer_id populated  → legacy orphan (createTerminalSale succeeded but
  //                              record-payment never ran). Sweep after 2 min.
  //   - transfer_id NULL       → verification-pending (createTerminalSale HTTP
  //                              call timed out and we never learned the transfer
  //                              ID). Identified by idempotency_key. Sweep after
  //                              30 s — the whole point is to resolve quickly so
  //                              the modal stops showing "verification pending".
  const pending = db
    .query<{
      id: string
      merchant_id: string
      order_id: string
      transfer_id: string | null
      idempotency_key: string | null
      device_id: string
      amount_cents: number
      created_at: string
    }, []>(
      `SELECT id, merchant_id, order_id, transfer_id, idempotency_key, device_id, amount_cents, created_at
       FROM pending_terminal_sales
       WHERE status = 'pending'
         AND (
           (transfer_id IS NOT NULL AND created_at <= datetime('now', '-2 minutes'))
           OR
           (transfer_id IS NULL AND created_at <= datetime('now', '-30 seconds'))
         )`,
    )
    .all()

  if (pending.length === 0) return

  console.log(`[reconcile] orphan sweep: ${pending.length} pending terminal sale(s) to check`)

  // Bulk-load orders and existing payments for all pending rows — 2 queries instead of 2N.
  // Finix API calls are still per-row (unavoidable network I/O); only DB reads are batched.
  const orderIds = [...new Set(pending.map(r => r.order_id))]
  const oph = orderIds.map(() => '?').join(',')

  type OrderRow = { id: string; status: string; subtotal_cents: number; tax_cents: number; total_cents: number }
  const orderMap = new Map(
    db
      .query<OrderRow, string[]>(`SELECT id, status, subtotal_cents, tax_cents, total_cents FROM orders WHERE id IN (${oph})`)
      .all(...orderIds)
      .map(o => [o.id, o]),
  )
  const existingPayments = db
    .query<{ order_id: string; finix_transfer_id: string | null }, string[]>(
      `SELECT order_id, finix_transfer_id FROM payments WHERE order_id IN (${oph})`,
    )
    .all(...orderIds)
  // Orders that already have at least one recorded leg (split in progress).
  const ordersWithPayments = new Set(existingPayments.map(p => p.order_id))
  // Exact (order, transfer) pairs already recorded — only THESE are true
  // duplicates. The old order-level "payment already exists" check discarded
  // a SUCCEEDED leg-2 charge just because leg 1 was recorded (M-10): the
  // money existed on Finix but was permanently lost locally.
  const recordedTransferKeys = new Set(
    existingPayments
      .filter(p => p.finix_transfer_id)
      .map(p => `${p.order_id}|${p.finix_transfer_id}`),
  )

  // Check Finix status per row; classify into delete-only or full recovery.
  // DB writes are deferred so they can be applied atomically in one transaction below.
  type WriteResult =
    | { action: 'delete'; pendingId: string }
    | {
        action: 'recover'
        pendingId: string
        paymentId: string
        row: (typeof pending)[0]
        finixAmount: number       // actual amount charged by Finix (includes tip)
        orderSubtotalCents: number // order subtotal (food only, pre-tax pre-tip)
        orderTaxCents: number     // order tax
        orderTotalCents: number   // order total — covered check for marking paid
        hasOtherLegs: boolean     // order already had recorded payment legs
        cardType: string | null
        cardLastFour: string | null
        approvalCode: string | null
        now: string
      }
  const writeResults: WriteResult[] = []

  // Track which pending rows came from the verification-pending path so that
  // after the DB transaction commits we can dispatch the outcome back to the
  // in-memory workflow (FSM leaves AWAITING_VERIFICATION → RECORDING/DECLINED).
  const verificationResolutions: Array<{
    orderId:    string
    outcome:    'approved' | 'declined'
    transferId: string | null
    approvedAmount?: number
    cardBrand?:   string | null
    cardLastFour?: string | null
    approvalCode?: string | null
    entryMode?:    string | null
    tipAmountCents?: number
    declineCode?:    string
    declineMessage?: string
  }> = []

  for (const row of pending) {
    try {
      const creds = await loadFinixCreds(row.merchant_id)
      if (!creds) {
        const ageMs = Date.now() - new Date(row.created_at).getTime()
        if (ageMs < 60 * 60 * 1000) {
          // Finix creds may not be configured yet — skip for up to 1 hour
          console.warn(`[reconcile] orphan ${row.id}: no Finix creds, skipping (age ${Math.round(ageMs / 60000)}m)`)
          continue
        }
        // Row is over 1 hour old with no creds — will never resolve. Discard it.
        console.warn(`[reconcile] orphan ${row.id}: no Finix creds after 1h — discarding`)
        writeResults.push({ action: 'delete', pendingId: row.id })
        if (!row.transfer_id && row.idempotency_key) {
          // Verification-pending row: unblock the order workflow
          verificationResolutions.push({
            orderId: row.order_id,
            outcome: 'declined',
            transferId: null,
            declineCode: 'NO_PROCESSOR_CREDENTIALS',
            declineMessage: 'Payment processor not configured — safe to retry',
          })
        }
        continue
      }

      // Branch on whether we already know the transfer ID.
      // verification-pending rows (transfer_id IS NULL) are looked up by idempotency_key.
      let status: {
        state:          string
        amount:         number
        tipAmountCents: number
        cardBrand:      string | null
        cardLastFour:   string | null
        approvalCode:   string | null
        entryMode:      string | null
        failureCode:    string | null
        failureMessage: string | null
      } | null = null
      let resolvedTransferId: string | null = row.transfer_id

      if (row.transfer_id) {
        try {
          const s = await getTerminalTransferStatus(creds, row.transfer_id)
          status = s
        } catch (err) {
          console.warn(`[reconcile] orphan ${row.id} getTerminalTransferStatus failed:`, (err as Error)?.message ?? err)
          continue
        }
      } else if (row.idempotency_key) {
        const found = await findTransferByIdempotencyId(creds, row.idempotency_key)
        if (!found) {
          // No transfer exists for this idempotency_id — Finix never received our
          // POST, or the customer never tapped. Declare this attempt declined and
          // let staff retry. The 409 guard unblocks once we delete the pending row.
          console.log(`[reconcile] orphan ${row.id}: no Finix transfer for idempotency_key=${row.idempotency_key} — declining verification`)
          writeResults.push({ action: 'delete', pendingId: row.id })
          verificationResolutions.push({
            orderId: row.order_id,
            outcome: 'declined',
            transferId: null,
            declineCode: 'VERIFICATION_NOT_FOUND',
            declineMessage: 'Processor has no record of the payment — safe to retry',
          })
          continue
        }
        status = {
          state:          found.state,
          amount:         found.amount,
          tipAmountCents: found.tipAmountCents,
          cardBrand:      found.cardBrand,
          cardLastFour:   found.cardLastFour,
          approvalCode:   found.approvalCode,
          entryMode:      found.entryMode,
          failureCode:    found.failureCode,
          failureMessage: found.failureMessage,
        }
        resolvedTransferId = found.id
      } else {
        // Neither transfer_id nor idempotency_key — malformed row. Remove.
        console.warn(`[reconcile] orphan ${row.id}: no transfer_id and no idempotency_key — removing`)
        writeResults.push({ action: 'delete', pendingId: row.id })
        continue
      }

      console.log(`[reconcile] orphan ${row.id}: transfer=${resolvedTransferId ?? 'NULL'} state=${status.state} amount=${status.amount}`)

      if (status.state === 'SUCCEEDED') {
        const order = orderMap.get(row.order_id)
        if (!order) {
          console.warn(`[reconcile] orphan ${row.id}: order ${row.order_id} not found, removing`)
          writeResults.push({ action: 'delete', pendingId: row.id })
          continue
        }

        if (resolvedTransferId && recordedTransferKeys.has(`${row.order_id}|${resolvedTransferId}`)) {
          console.log(`[reconcile] orphan ${row.id}: transfer ${resolvedTransferId} already recorded, cleaning up`)
          writeResults.push({ action: 'delete', pendingId: row.id })
          // If this was a verification-pending row, still dispatch so the FSM
          // leaves AWAITING_VERIFICATION (the client modal otherwise stays stuck).
          if (!row.transfer_id) {
            verificationResolutions.push({
              orderId: row.order_id,
              outcome: 'approved',
              transferId: resolvedTransferId,
              approvedAmount: status.amount,
              cardBrand:      status.cardBrand,
              cardLastFour:   status.cardLastFour,
              approvalCode:   status.approvalCode,
              entryMode:      status.entryMode,
              tipAmountCents: status.tipAmountCents,
            })
          }
          continue
        }

        const paymentId = `pay_${randomBytes(16).toString('hex')}`
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
        writeResults.push({
          action: 'recover',
          pendingId: row.id,
          paymentId,
          row: { ...row, transfer_id: resolvedTransferId ?? '' },
          finixAmount: status.amount,
          orderSubtotalCents: order.subtotal_cents,
          orderTaxCents: order.tax_cents,
          orderTotalCents: order.total_cents,
          hasOtherLegs: ordersWithPayments.has(row.order_id),
          cardType: status.cardBrand?.toLowerCase() ?? null,
          cardLastFour: status.cardLastFour ?? null,
          approvalCode: status.approvalCode ?? null,
          now,
        })
        if (!row.transfer_id) {
          verificationResolutions.push({
            orderId: row.order_id,
            outcome: 'approved',
            transferId: resolvedTransferId,
            approvedAmount: status.amount,
            cardBrand:      status.cardBrand,
            cardLastFour:   status.cardLastFour,
            approvalCode:   status.approvalCode,
            entryMode:      status.entryMode,
            tipAmountCents: status.tipAmountCents,
          })
        }

      } else if (status.state === 'FAILED' || status.state === 'CANCELED' || status.state === 'CANCELLED') {
        console.log(`[reconcile] orphan ${row.id}: transfer ${status.state}, removing`)
        writeResults.push({ action: 'delete', pendingId: row.id })
        if (!row.transfer_id) {
          verificationResolutions.push({
            orderId: row.order_id,
            outcome: 'declined',
            transferId: resolvedTransferId,
            declineCode:    status.failureCode ?? 'VERIFICATION_FAILED',
            declineMessage: status.failureMessage ?? `Transfer ${status.state} on processor`,
          })
        }

      } else {
        // Still PENDING — leave for next sweep
        console.log(`[reconcile] orphan ${row.id}: still ${status.state}, will retry`)
      }
    } catch (err) {
      console.warn(`[reconcile] orphan ${row.id} error:`, (err as Error)?.message ?? err)
    }
  }

  if (writeResults.length === 0) return

  // Apply all writes in one transaction: 3N individual round-trips → 1 atomic batch.
  // NOTE: bun:sqlite's db.transaction(fn) returns a callable wrapper — must be invoked.
  // Recoveries that fully cover the order total (marked paid) — drives the
  // post-commit broadcast wording below.
  const recoveredPaid = new Set<string>()
  // Recoveries skipped because the order was already fully collected —
  // logged loudly post-commit (possible duplicate manual record / double charge).
  const skippedCovered: Array<Extract<WriteResult, { action: 'recover' }>> = []
  db.transaction(() => {
    for (const w of writeResults) {
      if (w.action === 'delete') {
        db.run(`DELETE FROM pending_terminal_sales WHERE id = ?`, [w.pendingId])
      } else {
        // Already-covered guard: when the order's recorded legs ALREADY cover
        // its total — e.g. staff manually recorded the charge without a
        // transaction id (finix_transfer_id NULL, invisible to the
        // transfer-level dedup above), or a record-payment raced this sweep —
        // inserting this transfer would double-book the charge in every
        // SUM-based report. Skip the insert and surface it loudly instead: a
        // covered order plus a SUCCEEDED unrecorded transfer is either a
        // duplicate manual recording or a genuine double charge.
        const pre = db
          .query<{ total_paid: number; total_tips: number; total_surcharge: number; total_gc_offset: number }, [string]>(
            `SELECT COALESCE(SUM(amount_cents), 0)               AS total_paid,
                    COALESCE(SUM(tip_cents), 0)                  AS total_tips,
                    COALESCE(SUM(amex_surcharge_cents), 0)       AS total_surcharge,
                    COALESCE(SUM(gift_card_tax_offset_cents), 0) AS total_gc_offset
             FROM payments WHERE order_id = ?`,
          )
          .get(w.row.order_id)!
        const preBase = pre.total_paid - pre.total_tips - pre.total_surcharge
        const preOwed = w.orderTotalCents - pre.total_gc_offset
        if (pre.total_paid > 0 && Math.abs(preBase - preOwed) <= 10) {
          db.run(`DELETE FROM pending_terminal_sales WHERE id = ?`, [w.pendingId])
          skippedCovered.push(w)
          continue
        }

        // tip = Finix total - pre-tip base sent to terminal.
        // pending_terminal_sales.amount_cents is the pre-tip amount the terminal was
        // initiated with (subtotal + tax + any surcharges). The customer's tip is whatever
        // Finix charged above that. Using orderSubtotalCents+tax as the base is wrong
        // because it ignores surcharges added before the terminal was activated.
        const tipCents = Math.max(0, w.finixAmount - w.row.amount_cents)
        // Breakdown: for a recovered SPLIT leg (other legs already recorded),
        // tax is embedded in the leg amount (tax 0), matching the modal's
        // split-leg convention — subtracting the FULL order tax from a leg
        // base would corrupt (or negate) the leg subtotal. For an unsplit
        // recovery, subtotal + tax + tip == amount stays self-consistent.
        const paymentSubtotalCents = w.hasOtherLegs ? w.row.amount_cents : w.row.amount_cents - w.orderTaxCents
        const paymentTaxCents      = w.hasOtherLegs ? 0 : w.orderTaxCents
        db.run(
          `INSERT INTO payments (
            id, merchant_id, order_id, payment_type, subtotal_cents, tax_cents,
            tip_cents, amex_surcharge_cents, amount_cents, card_type, card_last_four,
            cardholder_name, transaction_id, processor, auth_code,
            signature_base64, receipt_email, split_mode, split_leg_number, split_total_legs,
            split_items_json, finix_transfer_id,
            created_at, completed_at
          ) VALUES (?, ?, ?, 'card', ?, ?, ?, 0, ?, ?, ?, NULL, ?, 'finix', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
          ON CONFLICT (order_id, finix_transfer_id) DO NOTHING`,
          [
            w.paymentId, w.row.merchant_id, w.row.order_id,
            paymentSubtotalCents, paymentTaxCents,
            tipCents, w.finixAmount,
            w.cardType, w.cardLastFour,
            w.row.transfer_id, w.approvalCode,
            w.row.transfer_id,
            w.now, w.now,
          ],
        )
        // Roll up across ALL of the order's legs — the order may have other
        // recorded legs (split mid-flight when record-payment crashed), and
        // overwriting with this leg's values alone would erase them. Mark the
        // order paid only when the collected base covers the order total
        // (mirrors record-payment's L-1 final-leg check, same ±10¢ tolerance);
        // otherwise leave the order open so staff complete the remaining legs
        // in the modal — its final leg SUMs over all rows incl. this one.
        const totals = db
          .query<{ total_paid: number; total_tips: number; total_surcharge: number; total_gc_offset: number }, [string]>(
            `SELECT COALESCE(SUM(amount_cents), 0)               AS total_paid,
                    COALESCE(SUM(tip_cents), 0)                  AS total_tips,
                    COALESCE(SUM(amex_surcharge_cents), 0)       AS total_surcharge,
                    COALESCE(SUM(gift_card_tax_offset_cents), 0) AS total_gc_offset
             FROM payments WHERE order_id = ?`,
          )
          .get(w.row.order_id)!
        const collectedBase = totals.total_paid - totals.total_tips - totals.total_surcharge
        const owedBase      = w.orderTotalCents - totals.total_gc_offset
        if (Math.abs(collectedBase - owedBase) <= 10) {
          db.run(
            `UPDATE orders SET status = 'paid', payment_method = 'card',
                   tip_cents = ?, paid_amount_cents = ?, updated_at = datetime('now')
             WHERE id = ? AND merchant_id = ?`,
            [totals.total_tips, totals.total_paid, w.row.order_id, w.row.merchant_id],
          )
          recoveredPaid.add(w.paymentId)
        }
        db.run(`DELETE FROM pending_terminal_sales WHERE id = ?`, [w.pendingId])
      }
    }
  })()

  // Post-transaction: logging, SSE notifications, reconciliation scheduling.
  // These are side-effects that must run after the commit, not inside it.
  for (const w of skippedCovered) {
    console.warn(
      `[reconcile] ⚠ orphan ${w.pendingId}: order ${w.row.order_id} is ALREADY fully collected but ` +
      `transfer ${w.row.transfer_id} ($${(w.finixAmount / 100).toFixed(2)}) has no payment row — ` +
      `possible duplicate manual recording or double charge; NOT recorded`,
    )
    logPaymentEvent('orphan_recovered', {
      merchantId: w.row.merchant_id, orderId: w.row.order_id,
      transferId: w.row.transfer_id ?? undefined, deviceId: w.row.device_id, amountCents: w.finixAmount,
      level: 'warn',
      message: `Orphaned transfer NOT recorded: order already fully collected — verify against the processor (duplicate manual record or double charge)`,
    })
    broadcastToMerchant(w.row.merchant_id, 'payment_alert', {
      orderId:     w.row.order_id,
      amountCents: w.finixAmount,
      type:        'unmatched',
    })
  }

  for (const w of writeResults) {
    if (w.action !== 'recover') continue
    if (skippedCovered.includes(w)) continue
    const fullyPaid = recoveredPaid.has(w.paymentId)
    console.log(
      `[reconcile] ✓ orphan ${w.pendingId}: auto-recovered payment ${w.paymentId} for order ` +
      `${w.row.order_id} ($${(w.finixAmount / 100).toFixed(2)})` +
      (fullyPaid ? '' : ' — PARTIAL: remaining split legs still owed, order left open'),
    )
    logPaymentEvent('orphan_recovered', {
      merchantId: w.row.merchant_id, orderId: w.row.order_id, paymentId: w.paymentId,
      transferId: w.row.transfer_id ?? undefined, deviceId: w.row.device_id, amountCents: w.finixAmount,
      message: fullyPaid
        ? `Auto-recovered from orphaned terminal sale ${w.pendingId}`
        : `Auto-recovered split leg from orphaned terminal sale ${w.pendingId} — order not fully collected, complete the remaining legs`,
      extra: { cardBrand: w.cardType, cardLastFour: w.cardLastFour },
    })
    // Notify dashboard clients (status only when the order was marked paid)
    broadcastToMerchant(w.row.merchant_id, 'order_updated',
      fullyPaid ? { orderId: w.row.order_id, status: 'paid' } : { orderId: w.row.order_id })
    // Schedule reconciliation (will instant-match since finix_transfer_id is set)
    scheduleReconciliation(w.row.merchant_id, w.paymentId, 'card')
  }

  // Dispatch verification outcomes back to any in-memory workflows still sitting
  // in AWAITING_VERIFICATION. If no workflow is registered (e.g. appliance just
  // restarted and rehydrate hasn't run yet), resolveTerminalVerificationForOrder
  // returns false and the DB state already reflects the outcome.
  for (const r of verificationResolutions) {
    try {
      const dispatched = resolveTerminalVerificationForOrder(r.orderId, r)
      if (!dispatched) {
        console.log(`[reconcile] verification-resolved ${r.orderId} → ${r.outcome} (no active workflow, DB-only)`)
      }
    } catch (err) {
      console.warn(`[reconcile] resolveTerminalVerificationForOrder(${r.orderId}) failed:`, (err as Error)?.message ?? err)
    }
  }
}

/**
 * Starts the background reconciliation sweep.
 *
 * - Runs once after `initialDelayMs` (default 5 s) so the DB and network
 *   are ready on startup.
 * - Then repeats every `SWEEP_INTERVAL_MS` (30 s) to catch any payments
 *   that failed reconciliation at any point since the last run.
 *
 * @returns cleanup function that cancels the repeating timer
 */
export function startAutoReconcile(initialDelayMs = 5_000): () => void {
  const runSweeps = async () => {
    if (_sweepRunning) {
      console.warn('[reconcile] sweep already in progress — skipping interval tick')
      return
    }
    _sweepRunning = true
    try {
      await sweepOrphanedTerminalSales().catch((err) =>
        console.warn('[reconcile] orphan sweep failed:', err?.message ?? err),
      )
      await recoverOrphanedCompletedPayments().catch((err) =>
        console.warn('[reconcile] completed-TTX orphan sweep failed:', err?.message ?? err),
      )
      await sweepUnreconciled().catch((err) =>
        console.warn('[reconcile] payment sweep failed:', err?.message ?? err),
      )
      // Prune payment_events older than 7 days (fire-and-forget, never throws).
      // NOTE: prunePaymentEvents() has no independent scheduler — this sweep is
      // its only call site. If reconciliation is ever disabled, move pruning elsewhere.
      prunePaymentEvents()
    } finally {
      _sweepRunning = false
    }
  }

  const initial = setTimeout(runSweeps, initialDelayMs)
  const interval = setInterval(runSweeps, SWEEP_INTERVAL_MS)

  return () => {
    clearTimeout(initial)
    clearInterval(interval)
  }
}

// ---------------------------------------------------------------------------
// Finix webhook transfer reconciliation
// ---------------------------------------------------------------------------

/**
 * Called immediately when Finix fires a transfer.succeeded webhook event.
 * Recovers unrecorded payments even when no TTX row exists (power failure case).
 *
 * Matching strategy (in order):
 *  1. Transfer already in payments → skip (idempotent)
 *  2. COMPLETED TTX row with this transfer ID → delegate to recoverOrphanedCompletedPayments()
 *  3. tags.orderId present → direct order lookup
 *  4. Fallback: closest unpaid local order within ±10 min with compatible amount
 */
export async function reconcileFinixWebhookTransfer(
  merchantId: string,
  transferId: string,
  amountCents: number,
  tagOrderId: string | null,
  occurredAt: string,
): Promise<void> {
  const db = getDatabase()

  // 1. Already recorded?
  const existing = db.query<{ id: string }, [string]>(
    `SELECT id FROM payments WHERE finix_transfer_id = ?`,
  ).get(transferId)
  if (existing) {
    console.log(`[finix-webhook] transfer ${transferId} already recorded as ${existing.id} — skipping`)
    return
  }

  // 2. COMPLETED TTX row with no payment → existing orphan recovery handles it
  const ttxRow = db.query<{ id: string }, [string]>(
    `SELECT id FROM terminal_transactions
     WHERE finix_transfer_id = ? AND tx_state = 'COMPLETED' AND payment_id IS NULL`,
  ).get(transferId)
  if (ttxRow) {
    console.log(`[finix-webhook] transfer ${transferId} has COMPLETED TTX ${ttxRow.id} — running orphan recovery`)
    await recoverOrphanedCompletedPayments()
    return
  }

  // 3. Resolve order
  type OrderRow = { id: string; status: string; subtotal_cents: number; tax_cents: number; service_charge_cents: number; total_cents: number }
  let order: OrderRow | null = null

  if (tagOrderId) {
    const tagged = db.query<OrderRow, [string, string]>(
      `SELECT id, status, subtotal_cents, tax_cents,
              COALESCE(service_charge_cents, 0) AS service_charge_cents, total_cents
       FROM orders WHERE id = ? AND merchant_id = ?`,
    ).get(tagOrderId, merchantId)
    if (tagged && ['paid', 'cancelled', 'refunded'].includes(tagged.status)) {
      console.log(`[finix-webhook] transfer ${transferId}: tagged order ${tagOrderId} already ${tagged.status} — skipping`)
      return
    }
    if (tagged) order = tagged
  }

  // Fallback: unpaid local order in ±10 min window with compatible amount
  if (!order) {
    const occurredMs  = new Date(occurredAt).getTime()
    const windowStart = new Date(occurredMs - 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19)
    const windowEnd   = new Date(occurredMs + 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19)

    const candidates = db.query<OrderRow, [string, string, string]>(
      `SELECT id, status, subtotal_cents, tax_cents,
              COALESCE(service_charge_cents, 0) AS service_charge_cents, total_cents
       FROM orders WHERE merchant_id = ? AND source = 'local'
         AND status NOT IN ('paid', 'cancelled', 'refunded')
         AND created_at BETWEEN ? AND ?
       ORDER BY created_at DESC LIMIT 10`,
    ).all(merchantId, windowStart, windowEnd)

    // Transfer amount must cover order total but not exceed 150% (tip sanity cap)
    order = candidates.find(
      (o) => amountCents >= o.total_cents && amountCents <= Math.ceil(o.total_cents * 1.5),
    ) ?? null
  }

  if (!order) {
    console.warn(
      `[finix-webhook] transfer ${transferId}: no matching unpaid order for ` +
      `$${(amountCents / 100).toFixed(2)} — will be caught by periodic sweep`,
    )
    return
  }

  // 4. Fetch card details from Finix API
  const creds = await loadFinixCreds(merchantId)
  let tipCents     = Math.max(0, amountCents - order.subtotal_cents - order.tax_cents - order.service_charge_cents)
  let cardBrand: string | null    = null
  let cardLastFour: string | null = null
  let approvalCode: string | null = null

  if (creds) {
    try {
      const details = await getTerminalTransferStatus(creds, transferId)
      tipCents     = details.tipAmountCents
      cardBrand    = details.cardBrand
      cardLastFour = details.cardLastFour
      approvalCode = details.approvalCode
    } catch (err) {
      console.warn(
        `[finix-webhook] getTerminalTransferStatus(${transferId}) failed — estimating tip:`,
        (err as Error)?.message ?? err,
      )
    }
  }

  // 5. Record payment atomically
  const paymentId = `pay_${randomBytes(16).toString('hex')}`
  const now       = new Date().toISOString().replace('T', ' ').slice(0, 19)
  let inserted    = false

  db.transaction(() => {
    const ins = db.run(
      `INSERT INTO payments (
         id, order_id, merchant_id, payment_type, amount_cents,
         subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents,
         card_type, card_last_four, transaction_id, processor, auth_code,
         finix_transfer_id, created_at, completed_at
       ) VALUES (?, ?, ?, 'card', ?, ?, ?, ?, 0, ?, ?, ?, 'finix_terminal', ?, ?, ?, ?)
       ON CONFLICT (order_id, finix_transfer_id) DO NOTHING`,
      [
        paymentId, order!.id, merchantId, amountCents,
        order!.subtotal_cents, order!.tax_cents, tipCents,
        cardBrand, cardLastFour,
        transferId, approvalCode,
        transferId, now, now,
      ],
    )
    inserted = ins.changes > 0
    if (inserted) {
      db.run(
        `UPDATE orders SET status = 'paid', paid_amount_cents = ?, tip_cents = ?,
           payment_method = 'card', updated_at = datetime('now')
         WHERE id = ? AND status NOT IN ('paid', 'cancelled', 'refunded')`,
        [amountCents, tipCents, order!.id],
      )
    }
  })()

  if (!inserted) {
    console.log(`[finix-webhook] transfer ${transferId} duplicate suppressed by UNIQUE constraint`)
    return
  }

  console.log(
    `[finix-webhook] ✓ transfer ${transferId} recovered as ${paymentId} ` +
    `for order ${order.id} ($${(amountCents / 100).toFixed(2)})`,
  )
  logPaymentEvent('finix_webhook_recovered', {
    merchantId,
    orderId:    order.id,
    paymentId,
    transferId,
    amountCents,
    level:   'warn',
    message: 'Auto-recovered via Finix webhook — no TTX row (likely power failure mid-transaction)',
  })
  scheduleReconciliation(merchantId, paymentId, 'card')
  broadcastToMerchant(merchantId, 'order_updated', {
    orderId: order.id, status: 'paid', paidAmountCents: amountCents,
  })
}

/**
 * Inserts a row into `payment_reconciliations`.  Idempotent: if a row already
 * exists for the payment_id it is replaced (e.g. re-check after manual retry).
 */
async function writeResult(
  merchantId: string,
  paymentId: string,
  status: ReconciliationStatus,
  finixTransferId: string | null,
  localAmountCents: number | null,
  finixAmountCents: number | null,
): Promise<void> {
  const db = getDatabase()
  const id = `rec_${randomBytes(8).toString('hex')}`

  db.run(
    `INSERT INTO payment_reconciliations
       (id, merchant_id, payment_id, finix_transfer_id, status,
        local_amount_cents, finix_amount_cents, checked_at, alerted)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'),
       CASE WHEN ? = 'unmatched' THEN 1 ELSE 0 END)
     ON CONFLICT(payment_id) DO UPDATE SET
       finix_transfer_id  = excluded.finix_transfer_id,
       status             = excluded.status,
       local_amount_cents = excluded.local_amount_cents,
       finix_amount_cents = excluded.finix_amount_cents,
       checked_at         = excluded.checked_at,
       alerted            = MAX(payment_reconciliations.alerted, excluded.alerted)`,
    [
      id, merchantId, paymentId, finixTransferId, status,
      localAmountCents, finixAmountCents,
      status,
    ],
  )
}
