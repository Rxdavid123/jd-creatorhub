import { after, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { deliverBookingNotificationsForBooking } from '@/lib/booking-email-delivery'

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Server configuration is incomplete.')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

function valid(raw: string, provided: string) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret || !/^[a-f0-9]{64}$/i.test(provided)) return false
  const expected = crypto.createHmac('sha256', secret).update(raw).digest()
  const received = Buffer.from(provided, 'hex')
  return expected.length === received.length && crypto.timingSafeEqual(expected, received)
}

function schedulePaidBookingEmails(bookingId: unknown) {
  if (typeof bookingId !== 'string') return
  after(async () => {
    try {
      await deliverBookingNotificationsForBooking(bookingId, ['confirmation', 'new_booking', 'creator_confirmation'])
    } catch {
      console.error('[booking-email] webhook dispatch failed', { bookingId })
    }
  })
}

export async function POST(request: Request) {
  const raw = await request.text()
  const signature = request.headers.get('x-razorpay-signature') || ''
  if (!valid(raw, signature)) return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 400 })
  const eventId = request.headers.get('x-razorpay-event-id') || ''
  if (!/^evt_[A-Za-z0-9]+$/.test(eventId)) return NextResponse.json({ error: 'Invalid event ID.' }, { status: 400 })

  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid webhook body.' }, { status: 400 })
  }

  let client: ReturnType<typeof admin>
  try {
    client = admin()
  } catch {
    return NextResponse.json({ error: 'Webhook processing is temporarily unavailable.' }, { status: 500 })
  }

  const { error: duplicateError } = await client.from('payment_webhook_events').insert({ event_id: eventId })
  if (duplicateError?.code === '23505') return NextResponse.json({ ok: true, duplicate: true })
  if (duplicateError) return NextResponse.json({ error: 'Webhook event could not be recorded.' }, { status: 500 })

  try {
    const entity = body?.payload?.payment?.entity
    const providerOrderId = typeof entity?.order_id === 'string' ? entity.order_id : ''
    if (body.event === 'payment.captured' && providerOrderId && typeof entity?.id === 'string') {
      const { data: bookingPayment, error: bookingLookupError } = await client
        .from('booking_payments')
        .select('amount_minor,currency')
        .eq('provider', 'razorpay')
        .eq('provider_order_id', providerOrderId)
        .maybeSingle()
      if (bookingLookupError) throw new Error('booking_payment_lookup_failed')

      if (bookingPayment) {
        if (entity.status !== 'captured'
          || !/^pay_[A-Za-z0-9]+$/.test(entity.id)
          || Number(entity.amount) !== Number(bookingPayment.amount_minor)
          || entity.currency !== bookingPayment.currency) {
          throw new Error('booking_payment_validation_failed')
        }
        const { data: result, error } = await client.rpc('confirm_booking_payment', {
          p_provider_order_id: providerOrderId,
          p_provider_payment_id: entity.id,
          p_amount_minor: Number(bookingPayment.amount_minor),
          p_currency: bookingPayment.currency,
        })
        if (error || !result) throw new Error('booking_payment_confirmation_failed')
        if (result.confirmed === true) schedulePaidBookingEmails(result.booking_id)
        else if (!['payment_captured_after_expiry', 'payment_captured_but_slot_unavailable'].includes(result.reason)) {
          throw new Error('booking_payment_confirmation_failed')
        }
      } else {
        const { data: payment } = await client.from('payments')
          .select('order_id,amount_minor,currency')
          .eq('provider_order_id', providerOrderId)
          .maybeSingle()
        if (payment && entity.status === 'captured'
          && Number(entity.amount) === Number(payment.amount_minor)
          && entity.currency === payment.currency) {
          await client.rpc('mark_order_paid', {
            p_order_id: payment.order_id,
            p_provider_payment_id: entity.id,
            p_provider_order_id: providerOrderId,
            p_amount_minor: payment.amount_minor,
            p_currency: payment.currency,
          })
        }
      }
    }

    if (body.event === 'payment.failed' && providerOrderId) {
      const { data: bookingPayment, error: bookingLookupError } = await client
        .from('booking_payments')
        .select('amount_minor,currency')
        .eq('provider', 'razorpay')
        .eq('provider_order_id', providerOrderId)
        .maybeSingle()
      if (bookingLookupError) throw new Error('booking_payment_lookup_failed')

      if (bookingPayment) {
        if (entity.status !== 'failed'
          || !/^pay_[A-Za-z0-9]+$/.test(entity.id || '')
          || Number(entity.amount) !== Number(bookingPayment.amount_minor)
          || entity.currency !== bookingPayment.currency) {
          throw new Error('booking_payment_validation_failed')
        }
        const { error } = await client.rpc('mark_booking_payment_failed', {
          p_provider_order_id: providerOrderId,
          p_provider_payment_id: typeof entity.id === 'string' ? entity.id : null,
          p_reason: typeof entity.error_description === 'string' ? entity.error_description : 'payment_failed',
        })
        if (error) throw new Error('booking_payment_failure_record_failed')
      } else {
        await client.rpc('record_payment_failed', {
          p_provider_order_id: providerOrderId,
          p_provider_payment_id: entity?.id || null,
          p_reason: entity?.error_description || 'Payment failed',
        })
      }
    }

    return NextResponse.json({ ok: true })
  } catch {
    await client.from('payment_webhook_events').delete().eq('event_id', eventId)
    return NextResponse.json({ error: 'Webhook processing failed. The provider may retry this event.' }, { status: 500 })
  }
}
