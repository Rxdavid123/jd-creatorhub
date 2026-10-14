import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Server configuration is incomplete.')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}
function signature(orderId: string, paymentId: string) {
  const secret = process.env.RAZORPAY_KEY_SECRET
  if (!secret) throw new Error('Razorpay credentials are not configured.')
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex')
}
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body?.razorpay_order_id || !body?.razorpay_payment_id || !body?.razorpay_signature || !body?.internal_order_id) return NextResponse.json({ error: 'Incomplete payment response.' }, { status: 400 })
    const expected = signature(body.razorpay_order_id, body.razorpay_payment_id)
    const a = Buffer.from(expected); const b = Buffer.from(String(body.razorpay_signature))
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return NextResponse.json({ error: 'Invalid payment signature.' }, { status: 400 })
    const keyId = process.env.RAZORPAY_KEY_ID
    const keySecret = process.env.RAZORPAY_KEY_SECRET
    if (!keyId || !keySecret) return NextResponse.json({ error: 'Payment verification is not configured.' }, { status: 500 })
    const providerResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(body.razorpay_payment_id)}`, { headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` } })
    const providerPayment = await providerResponse.json()
    if (!providerResponse.ok || providerPayment.order_id !== body.razorpay_order_id || providerPayment.status !== 'captured') return NextResponse.json({ error: 'Payment is not captured.' }, { status: 400 })
    const client = admin()
    const { data: payment } = await client.from('payments').select('amount_minor,currency').eq('order_id', body.internal_order_id).eq('provider_order_id', body.razorpay_order_id).maybeSingle()
    if (!payment || Number(providerPayment.amount) !== Number(payment.amount_minor) || providerPayment.currency !== payment.currency) return NextResponse.json({ error: 'Payment amount or currency mismatch.' }, { status: 400 })
    if (!payment) return NextResponse.json({ error: 'Payment record not found.' }, { status: 400 })
    const { data, error } = await client.rpc('mark_order_paid', { p_order_id: body.internal_order_id, p_provider_payment_id: body.razorpay_payment_id, p_provider_order_id: body.razorpay_order_id, p_amount_minor: payment.amount_minor, p_currency: payment.currency })
    if (error || data !== true) return NextResponse.json({ error: 'Payment could not be verified.' }, { status: 400 })
    return NextResponse.json({ ok: true, orderId: body.internal_order_id })
  } catch { return NextResponse.json({ error: 'Payment verification failed.' }, { status: 500 }) }
}
