import { NextResponse } from 'next/server'
import { createBookingPaymentAdminClient, getRazorpayTestCredentials, RazorpayConfigurationError } from '@/lib/booking-payment-server'

function rpcErrorStatus(message: string) {
  if (message.includes('booking_not_found')) return 404
  if (message.includes('payment_expired')) return 410
  if (message.includes('slot_taken') || message.includes('booking_not_awaiting_payment')) return 409
  if (message.includes('payment_not_required') || message.includes('outside_') || message.includes('blocked_')) return 400
  return 503
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const bookingToken = typeof body?.bookingToken === 'string' ? body.bookingToken : ''
  if (!/^[a-f0-9]{48}$/i.test(bookingToken)) {
    return NextResponse.json({ error: 'This booking link is invalid.' }, { status: 404 })
  }

  let credentials: ReturnType<typeof getRazorpayTestCredentials>
  try {
    credentials = getRazorpayTestCredentials()
  } catch (error) {
    if (error instanceof RazorpayConfigurationError) {
      console.error('[booking-payment] Razorpay configuration check failed', { code: error.code })
      return NextResponse.json({
        error: 'Test Mode checkout is temporarily unavailable.',
        code: error.code,
      }, { status: 503 })
    }
    return NextResponse.json({ error: 'Test Mode checkout is temporarily unavailable.' }, { status: 503 })
  }

  try {
    const client = createBookingPaymentAdminClient()
    const { data: attempt, error } = await client.rpc('prepare_booking_payment_attempt', { p_token: bookingToken })
    if (error || !attempt) {
      const message = error?.message || ''
      return NextResponse.json({ error: message.includes('payment_expired') ? 'This payment reservation has expired.' : message.includes('booking_not_found') ? 'This booking link is invalid.' : 'Unable to prepare payment for this booking.' }, { status: rpcErrorStatus(message) })
    }

    const amount = Number(attempt.amount_minor)
    const currency = typeof attempt.currency === 'string' ? attempt.currency : ''
    if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) {
      return NextResponse.json({ error: 'The booking payment details are unavailable.' }, { status: 500 })
    }

    let orderId = typeof attempt.provider_order_id === 'string' ? attempt.provider_order_id : ''
    if (attempt.should_create === true) {
      const response = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: credentials.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, currency, receipt: attempt.receipt, notes: { flow: 'appointment_booking' } }),
        signal: AbortSignal.timeout(10_000),
      })
      const providerOrder = await response.json().catch(() => null)
      if (!response.ok || typeof providerOrder?.id !== 'string'
        || providerOrder.amount !== amount || providerOrder.currency !== currency
        || providerOrder.receipt !== attempt.receipt) {
        await client.rpc('fail_booking_payment_order_creation', {
          p_attempt_id: attempt.attempt_id,
          p_reason: 'payment_order_creation_failed',
        })
        return NextResponse.json({ error: 'Unable to start Test Mode checkout. You can retry while your reservation is active.' }, { status: 502 })
      }
      orderId = providerOrder.id
      const { data: recorded, error: recordError } = await client.rpc('record_booking_payment_order', {
        p_attempt_id: attempt.attempt_id,
        p_provider_order_id: orderId,
      })
      if (recordError || recorded !== true) {
        return NextResponse.json({ error: 'Payment could not be prepared. You can retry while your reservation is active.' }, { status: 503 })
      }
    } else if (attempt.creating === true || !orderId) {
      return NextResponse.json({ error: 'Checkout is being prepared. Please retry in a few seconds.' }, { status: 409 })
    }

    return NextResponse.json({
      keyId: credentials.keyId,
      orderId,
      amount,
      currency,
      expiresAt: attempt.expires_at,
    })
  } catch {
    return NextResponse.json({ error: 'Unable to start Test Mode checkout. Please try again.' }, { status: 503 })
  }
}
