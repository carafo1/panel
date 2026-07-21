/**
 * Waafi Pay payment integration client.
 *
 * Docs: https://docs.waafipay.net/
 *
 * Used by:
 *  - #18 Multi-Payment Billing (Stripe / Waafi / Manual)
 *
 * Environment variables:
 *   WAAFI_API_URL       - base URL for the Waafi Pay API (e.g. https://api.waafipay.net)
 *   WAAFI_MERCHANT_ID   - merchant ID issued by Waafi
 *   WAAFI_API_KEY       - API key issued by Waafi
 *   WAAFI_API_USER_ID   - API user ID issued by Waafi
 *
 * When the WAAFI_* env vars are not set, runs in DEMO MODE - logs to
 * the console and returns simulated responses so the billing UI can be
 * exercised end-to-end without a real Waafi account.
 *
 * No external packages are required - uses the global `fetch` shipped
 * with Node.js 18+ and Bun.
 */

/**
 * Read a Waafi env var, treating the shipped placeholders as unset.
 *
 * The default .env ships `replace-with-...` values. Without this check they
 * count as "configured", which flips `isWaafiDemoMode()` to false and makes
 * the integration fire real API calls with a merchant ID of
 * "replace-with-your-merchant-id" instead of safely staying in demo mode.
 */
function waafiEnv(name: string): string | null {
  const v = process.env[name]
  if (!v) return null
  const t = v.trim()
  if (!t) return null
  if (/^(replace[-_ ]?with|your[-_ ]|changeme|xxx+|todo)/i.test(t)) return null
  return t
}

function getApiUrl(): string | null {
  return waafiEnv('WAAFI_API_URL')
}

function getMerchantId(): string | null {
  return waafiEnv('WAAFI_MERCHANT_ID')
}

function getApiKey(): string | null {
  return waafiEnv('WAAFI_API_KEY')
}

function getApiUserId(): string | null {
  return waafiEnv('WAAFI_API_USER_ID')
}

export function isWaafiConfigured(): boolean {
  return Boolean(
    getApiUrl() && getMerchantId() && getApiKey() && getApiUserId()
  )
}

export function isWaafiDemoMode(): boolean {
  return !isWaafiConfigured()
}

/**
 * Common request envelope sent to every Waafi API call.
 * See: https://docs.waafipay.net/
 */
interface WaafiRequestEnvelope {
  requestType: string
  apiUserId: string
  apiKey: string
  merchantId: string
  [key: string]: unknown
}

interface CreatePaymentOptions {
  amount: number
  currency: string // "USD", "SOS", etc.
  description: string
  callbackUrl: string
  returnUrl: string
  reference: string
}

interface CreatePaymentResult {
  success: boolean
  paymentUrl?: string
  transactionId?: string
  error?: string
}

interface VerifyPaymentResult {
  success: boolean
  status: 'pending' | 'completed' | 'failed'
  amount?: number
  currency?: string
  error?: string
}

interface PaymentStatusResult {
  success: boolean
  status: string
  error?: string
}

/**
 * Submit a request to the Waafi Pay API.
 * Throws on network / HTTP errors so callers can catch and surface.
 */
async function callWaafi<T = unknown>(
  payload: WaafiRequestEnvelope
): Promise<T> {
  const baseUrl = getApiUrl()!
  const url = baseUrl.replace(/\/$/, '') + '/api'

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    // Don't hang forever - 30s budget per call.
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `Waafi API HTTP ${response.status}: ${text.slice(0, 500)}`
    )
  }

  return (await response.json()) as T
}

/**
 * Create a payment request.
 *
 * Returns a `paymentUrl` the user should be redirected to (hosted Waafi
 * checkout) and a `transactionId` we persist on the Payment record so we
 * can match the async callback later.
 */
export async function createPayment(
  opts: CreatePaymentOptions
): Promise<CreatePaymentResult> {
  // ── DEMO MODE ──────────────────────────────────────────────────
  if (isWaafiDemoMode()) {
    console.log('[waafi] DEMO MODE: createPayment', opts)
    const transactionId = `waafi_demo_${Date.now()}`
    const paymentUrl = `${
      process.env.NEXT_PUBLIC_APP_URL || ''
    }/billing/waafi-demo?tx=${transactionId}`
    return {
      success: true,
      paymentUrl,
      transactionId,
    }
  }

  // ── LIVE MODE ──────────────────────────────────────────────────
  try {
    const payload: WaafiRequestEnvelope = {
      requestType: 'PaymentRequest',
      apiUserId: getApiUserId()!,
      apiKey: getApiKey()!,
      merchantId: getMerchantId()!,
      paymentAmount: Number(opts.amount.toFixed(2)),
      paymentCurrency: opts.currency,
      paymentDescription: opts.description,
      callbackUrl: opts.callbackUrl,
      returnUrl: opts.returnUrl,
      reference: opts.reference,
    }

    const result = await callWaafi<{
      responseCode?: string
      responseMsg?: string
      paymentUrl?: string
      transactionId?: string
      txId?: string
      trxId?: string
    }>(payload)

    // Waafi's typical success response code is "2001" (Request Successfully
    // Completed). Be defensive: accept anything that includes a payment URL
    // or transaction id.
    const transactionId = result.transactionId || result.txId || result.trxId
    const paymentUrl = result.paymentUrl

    if (!paymentUrl || !transactionId) {
      return {
        success: false,
        error:
          result.responseMsg ||
          `Waafi response missing paymentUrl/transactionId (code ${result.responseCode ?? 'n/a'})`,
      }
    }

    return {
      success: true,
      paymentUrl,
      transactionId,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[waafi] createPayment failed:', message)
    return {
      success: false,
      error: message,
    }
  }
}

/**
 * Verify/confirm a payment after Waafi calls our callback.
 *
 * Returns a normalised status of `pending`, `completed`, or `failed`.
 */
export async function verifyPayment(
  transactionId: string
): Promise<VerifyPaymentResult> {
  // ── DEMO MODE ──────────────────────────────────────────────────
  if (isWaafiDemoMode()) {
    console.log('[waafi] DEMO MODE: verifyPayment', transactionId)
    // Simulate a successful verification for demo transactions.
    return {
      success: true,
      status: 'completed',
      amount: 0, // unknown in demo - the caller has the original amount
      currency: 'USD',
    }
  }

  // ── LIVE MODE ──────────────────────────────────────────────────
  try {
    const payload: WaafiRequestEnvelope = {
      requestType: 'TransactionStatus',
      apiUserId: getApiUserId()!,
      apiKey: getApiKey()!,
      merchantId: getMerchantId()!,
      transactionId,
    }

    const result = await callWaafi<{
      responseCode?: string
      responseMsg?: string
      status?: string
      transactionStatus?: string
      amount?: number
      paymentAmount?: number
      currency?: string
      paymentCurrency?: string
    }>(payload)

    const rawStatus = (
      result.status ||
      result.transactionStatus ||
      result.responseMsg ||
      ''
    )
      .toString()
      .toLowerCase()

    // Common Waafi status strings -> our internal status enum.
    let status: VerifyPaymentResult['status'] = 'pending'
    if (
      rawStatus.includes('success') ||
      rawStatus.includes('completed') ||
      rawStatus.includes('paid') ||
      result.responseCode === '2001'
    ) {
      status = 'completed'
    } else if (
      rawStatus.includes('fail') ||
      rawStatus.includes('cancel') ||
      rawStatus.includes('declined') ||
      rawStatus.includes('error')
    ) {
      status = 'failed'
    }

    return {
      success: true,
      status,
      amount: result.amount ?? result.paymentAmount,
      currency: result.currency || result.paymentCurrency,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[waafi] verifyPayment failed:', message)
    return {
      success: false,
      status: 'failed',
      error: message,
    }
  }
}

/**
 * Get the current status of a Waafi payment (lightweight poll).
 * Returns the raw status string from Waafi alongside our normalised view.
 */
export async function getPaymentStatus(
  transactionId: string
): Promise<PaymentStatusResult> {
  if (isWaafiDemoMode()) {
    console.log('[waafi] DEMO MODE: getPaymentStatus', transactionId)
    return { success: true, status: 'completed' }
  }

  try {
    const verification = await verifyPayment(transactionId)
    if (!verification.success) {
      return {
        success: false,
        status: 'unknown',
        error: verification.error,
      }
    }
    return { success: true, status: verification.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[waafi] getPaymentStatus failed:', message)
    return {
      success: false,
      status: 'unknown',
      error: message,
    }
  }
}
