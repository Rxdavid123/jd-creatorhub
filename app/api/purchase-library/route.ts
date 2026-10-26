'use server'

import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Server configuration is incomplete.')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') || ''
  if (!/^[a-f0-9]{64}$/i.test(token)) return NextResponse.json({ error: 'Purchase access is invalid.' }, { status: 400 })

  try {
    const client = admin()
    const { data: capability, error: capabilityError } = await client.from('download_tokens').select('order_id,product_id,expires_at,revoked_at').eq('token_hash', hashToken(token)).maybeSingle()
    if (capabilityError || !capability || capability.revoked_at || new Date(capability.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: 'Purchase access is invalid or expired.' }, { status: 403 })

    const [{ data: payment }, { data: order }, { data: item }] = await Promise.all([
      client.from('payments').select('status').eq('order_id', capability.order_id).eq('provider', 'razorpay').eq('status', 'captured').not('provider_payment_id', 'is', null).maybeSingle(),
      client.from('orders').select('id,status,created_at').eq('id', capability.order_id).maybeSingle(),
      client.from('order_items').select('product_id,product_name,quantity').eq('order_id', capability.order_id).eq('product_id', capability.product_id).maybeSingle(),
    ])
    if (!payment || !order || order.status === 'cancelled' || !item) return NextResponse.json({ error: 'This purchase is not currently eligible for access.' }, { status: 403 })

    const { data: product } = await client.from('products').select('id,name,slug,description,thumbnail_url,store_id').eq('id', capability.product_id).maybeSingle()
    if (!product) return NextResponse.json({ error: 'The purchased product is no longer available.' }, { status: 410 })
    const { data: store } = await client.from('stores').select('store_name,username').eq('id', product.store_id).maybeSingle()

    return NextResponse.json({ entitlement: { orderId: order.id, purchasedAt: order.created_at, expiresAt: capability.expires_at, quantity: item.quantity }, product: { ...product, storeName: store?.store_name || null, storeUsername: store?.username || null } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Unable to load the purchase library.' }, { status: 500 })
  }
}
