import { createHmac, timingSafeEqual } from 'node:crypto'

export function isRazorpayTestKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^rzp_test_[A-Za-z0-9]+$/.test(value)
}

export type RazorpayConfigurationErrorCode =
  | 'RAZORPAY_TEST_KEY_ID_MISSING'
  | 'RAZORPAY_KEY_ID_NOT_TEST_MODE'
  | 'RAZORPAY_TEST_KEY_SECRET_MISSING'

export function getRazorpayTestConfigurationErrorCode(
  keyId: string | undefined,
  keySecret: string | undefined,
): RazorpayConfigurationErrorCode | null {
  if (!keyId?.trim()) return 'RAZORPAY_TEST_KEY_ID_MISSING'
  if (!isRazorpayTestKey(keyId)) return 'RAZORPAY_KEY_ID_NOT_TEST_MODE'
  if (!keySecret?.trim()) return 'RAZORPAY_TEST_KEY_SECRET_MISSING'
  return null
}

export function getRazorpayConfigurationDiagnostics(
  keyId: string | undefined,
  keySecret: string | undefined,
  deploymentEnvironment: string,
  runtime: string,
) {
  return {
    razorpayKeyIdPresent: Boolean(keyId?.trim()),
    razorpayKeyIdHasTestPrefix: typeof keyId === 'string' && keyId.startsWith('rzp_test_'),
    razorpayKeySecretPresent: Boolean(keySecret?.trim()),
    deploymentEnvironment,
    runtime,
  }
}

export function verifyRazorpayCheckoutSignature(
  orderId: string,
  paymentId: string,
  providedSignature: string,
  secret: string,
) {
  if (!/^order_[A-Za-z0-9]+$/.test(orderId)
    || !/^pay_[A-Za-z0-9]+$/.test(paymentId)
    || !/^[a-f0-9]{64}$/i.test(providedSignature)
    || !secret) return false

  const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest()
  const received = Buffer.from(providedSignature, 'hex')
  return received.length === expected.length && timingSafeEqual(expected, received)
}

export function matchesCapturedRazorpayPayment(
  payment: { id?: unknown; order_id?: unknown; status?: unknown; amount?: unknown; currency?: unknown },
  expected: { paymentId: string; orderId: string; amountMinor: number; currency: string },
) {
  return payment.id === expected.paymentId
    && payment.order_id === expected.orderId
    && payment.status === 'captured'
    && Number.isSafeInteger(Number(payment.amount))
    && Number(payment.amount) === expected.amountMinor
    && payment.currency === expected.currency
}
