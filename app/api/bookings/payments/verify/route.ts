import { after, NextResponse } from 'next/server'
import { deliverBookingNotificationsForBooking } from '@/lib/booking-email-delivery'
import { createBookingPaymentAdminClient, getRazorpayTestCredentials, RazorpayConfigurationError } from '@/lib/booking-payment-server'
import { matchesCapturedRazorpayPayment, verifyRazorpayCheckoutSignature } from '@/lib/razorpay-booking-security'

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const bookingToken = typeof body?.bookingToken === 'string' ? body.bookingToken : ''
  const orderId = typeof body?.razorpay_order_id === 'string' ? body.razorpay_order_id : ''
  const paymentId = typeof body?.razorpay_payment_id === 'string' ? body.razorpay_payment_id : ''
  const providedSignature = typeof body?.razorpay_signature === 'string' ? body.razorpay_signature : ''
  if (!/^[a-f0-9]{48}$/i.test(bookingToken)
    || !/^order_[A-Za-z0-9]+$/.test(orderId)
    || !/^pay_[A-Za-z0-9]+$/.test(paymentId)
    || !/^[a-f0-9]{64}$/i.test(providedSignature)) {
    return NextResponse.json({ error: 'Payment verification details are incomplete.' }, { status: 400 })
  }

  let credentials: ReturnType<typeof getRazorpayTestCredentials>
  try {
    credentials = getRazorpayTestCredentials()
  } catch (error) {
    if (error instanceof RazorpayConfigurationError) {
      console.error('[booking-payment] Razorpay configuration check failed', { code: error.code })
      return NextResponse.json({
        error: 'Test Mode payment verification is unavailable.',
        code: error.code,
      }, { status: 503 })
    }
    return NextResponse.json({ error: 'Test Mode payment verification is unavailable.' }, { status: 503 })
  }
  if (!verifyRazorpayCheckoutSignature(orderId, paymentId, providedSignature, credentials.keySecret)) {
    return NextResponse.json({ error: 'Payment verification was unsuccessful.' }, { status: 400 })
  }

  try {
    const client = createBookingPaymentAdminClient()
    const { data: expected, error: paymentError } = await client.rpc('get_booking_payment_for_verification', {
      p_token: bookingToken,
      p_provider_order_id: orderId,
    })
    if (paymentError || !expected) return NextResponse.json({ error: 'Payment does not match this booking.' }, { status: 404 })

    const providerResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: credentials.authorization },
      signal: AbortSignal.timeout(10_000),
    })
    const providerPayment = await providerResponse.json().catch(() => null)
    if (!providerResponse.ok || !providerPayment) {
      return NextResponse.json({ error: 'Payment status could not be verified. You can retry safely.' }, { status: 502 })
    }

    if (providerPayment.status === 'failed'
      && providerPayment.order_id === orderId
      && providerPayment.id === paymentId
      && Number(providerPayment.amount) === Number(expected.amount_minor)
      && providerPayment.currency === expected.currency) {
      await client.rpc('mark_booking_payment_failed', {
        p_provider_order_id: orderId,
        p_provider_payment_id: paymentId,
        p_reason: typeof providerPayment.error_description === 'string' ? providerPayment.error_description : 'payment_failed',
      })
      return NextResponse.json({ error: 'Payment was not completed. Retry while your reservation is active.' }, { status: 402 })
    }

    if (!matchesCapturedRazorpayPayment(providerPayment, {
      paymentId,
      orderId,
      amountMinor: Number(expected.amount_minor),
      currency: String(expected.currency),
    })) {
      return NextResponse.json({ error: 'Payment is not captured or does not match this booking.' }, { status: 409 })
    }

    const { data: result, error: confirmError } = await client.rpc('confirm_booking_payment', {
      p_provider_order_id: orderId,
      p_provider_payment_id: paymentId,
      p_amount_minor: Number(expected.amount_minor),
      p_currency: String(expected.currency),
    })
    if (confirmError || !result) {
      return NextResponse.json({ error: 'Payment was received but booking confirmation is still processing. Refresh this page shortly.' }, { status: 503 })
    }
    if (result.confirmed !== true) {
      const message = result.reason === 'payment_captured_after_expiry'
        || result.reason === 'payment_captured_but_slot_unavailable'
        ? 'Payment was captured, but the reservation could not be confirmed. Contact the creator for next steps; no automatic refund was issued.'
        : 'Payment could not be matched to an active booking. Contact the creator for assistance.'
      return NextResponse.json({ error: message, captured: true }, { status: 409 })
    }

    const bookingId = typeof result.booking_id === 'string' ? result.booking_id : null
    if (bookingId) {
      after(async () => {
        try {
          await deliverBookingNotificationsForBooking(bookingId, ['confirmation', 'new_booking', 'creator_confirmation'])
        } catch {
          console.error('[booking-email] paid booking dispatch failed', { bookingId })
        }
      })
    }
    return NextResponse.json({ ok: true, confirmationUrl: `/booking/${encodeURIComponent(bookingToken)}` })
  } catch {
    return NextResponse.json({ error: 'Payment verification is temporarily unavailable. You can retry safely.' }, { status: 503 })
  }
}
