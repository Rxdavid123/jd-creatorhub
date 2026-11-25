import { createHmac, timingSafeEqual } from 'node:crypto'

export function isRazorpayTestKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^rzp_test_[A-Za-z0-9]+$/.test(value)
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
