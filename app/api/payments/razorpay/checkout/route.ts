import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase server configuration is incomplete.')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

function razorpayAuth() {
  const id = process.env.RAZORPAY_KEY_ID
  const secret = process.env.RAZORPAY_KEY_SECRET
  if (!id || !secret) throw new Error('Razorpay test credentials are not configured.')
  return { id, header: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    const productId = typeof body?.productId === 'string' ? body.productId : ''
    const quantity = Number(body?.quantity)
    const customerName = typeof body?.customerName === 'string' ? body.customerName : null
    const customerEmail = typeof body?.customerEmail === 'string' ? body.customerEmail : null
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return NextResponse.json({ error: 'Invalid product or quantity.' }, { status: 400 })
    if (customerEmail && (!customerEmail.includes('@') || customerEmail.length > 320)) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
    const client = admin()
    const { data: checkout, error } = await client.rpc('create_public_checkout_order', { p_product_id: productId, p_quantity: quantity, p_customer_name: customerName, p_customer_email: customerEmail })
    if (error || !checkout?.[0]) return NextResponse.json({ error: error?.message || 'Product is unavailable.' }, { status: 400 })
    const row = checkout[0]
    const razorpay = razorpayAuth()
    const response = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { Authorization: razorpay.header, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: row.amount_minor, currency: row.currency, receipt: row.order_id, notes: { internal_order_id: row.order_id } }) })
    const providerOrder = await response.json()
    if (!response.ok || !providerOrder.id) return NextResponse.json({ error: 'Unable to start payment.' }, { status: 502 })
    const recorded = await client.rpc('record_payment_created', { p_order_id: row.order_id, p_provider_order_id: providerOrder.id, p_amount_minor: row.amount_minor, p_currency: row.currency })
    if (recorded.error || recorded.data !== true) return NextResponse.json({ error: 'Unable to record payment.' }, { status: 500 })
    return NextResponse.json({ keyId: razorpay.id, orderId: providerOrder.id, internalOrderId: row.order_id, amount: row.amount_minor, currency: row.currency, name: row.product_name })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Payment setup failed.'
    return NextResponse.json({ error: message.includes('credentials') ? message : 'Payment setup failed.' }, { status: 500 })
  }
}
