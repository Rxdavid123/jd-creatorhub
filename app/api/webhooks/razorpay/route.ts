import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { NextResponse } from 'next/server'

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Server configuration is incomplete.')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}
function valid(raw: string, provided: string) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) return false
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  const a = Buffer.from(expected); const b = Buffer.from(provided)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
export async function POST(request: Request) {
  const raw = await request.text()
  const signature = request.headers.get('x-razorpay-signature') || ''
  if (!valid(raw, signature)) return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 400 })
  const eventId = request.headers.get('x-razorpay-event-id')
  if (!eventId) return NextResponse.json({ error: 'Missing event ID.' }, { status: 400 })
  try {
    const body = JSON.parse(raw)
    const client = admin()
    const { error: duplicateError } = await client.from('payment_webhook_events').insert({ event_id: eventId })
    if (duplicateError?.code === '23505') return NextResponse.json({ ok: true, duplicate: true })
    if (duplicateError) return NextResponse.json({ error: 'Webhook event could not be recorded.' }, { status: 500 })
    const entity = body?.payload?.payment?.entity
    if (body.event === 'payment.captured' && entity?.status === 'captured' && entity?.order_id && entity?.id) {
      const { data: payment } = await client.from('payments').select('order_id,amount_minor,currency').eq('provider_order_id', entity.order_id).maybeSingle()
      if (payment && Number(entity.amount) === Number(payment.amount_minor) && entity.currency === payment.currency) await client.rpc('mark_order_paid', { p_order_id: payment.order_id, p_provider_payment_id: entity.id, p_provider_order_id: entity.order_id, p_amount_minor: payment.amount_minor, p_currency: payment.currency })
    }
    if (body.event === 'payment.failed' && entity?.order_id) await client.rpc('record_payment_failed', { p_provider_order_id: entity.order_id, p_provider_payment_id: entity.id || null, p_reason: entity.error_description || 'Payment failed' })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 }) }
}
