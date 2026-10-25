import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'product-files'
const SIGNED_URL_SECONDS = 60

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
  const url = new URL(request.url)
  const token = url.searchParams.get('token') || ''
  const productId = url.searchParams.get('productId') || ''
  if (!/^[a-f0-9]{64}$/i.test(token) || !/^[0-9a-f-]{36}$/.test(productId)) {
    return NextResponse.json({ error: 'Download authorization is invalid.' }, { status: 400 })
  }

  try {
    const client = admin()
    const { data: capability, error: capabilityError } = await client
      .from('download_tokens')
      .select('order_id,product_id,expires_at,revoked_at')
      .eq('token_hash', hashToken(token))
      .maybeSingle()

    if (capabilityError || !capability || capability.product_id !== productId || capability.revoked_at || new Date(capability.expires_at).getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Download authorization is invalid or expired.' }, { status: 403 })
    }

    const { data: payment } = await client
      .from('payments')
      .select('id,status,order_id,amount_minor,currency,provider_payment_id')
      .eq('order_id', capability.order_id)
      .eq('provider', 'razorpay')
      .eq('status', 'captured')
      .not('provider_payment_id', 'is', null)
      .maybeSingle()
    if (!payment) return NextResponse.json({ error: 'A captured payment is required.' }, { status: 403 })

    const { data: order } = await client.from('orders').select('id,status').eq('id', capability.order_id).maybeSingle()
    if (!order || order.status === 'cancelled') return NextResponse.json({ error: 'This order is not eligible for download.' }, { status: 403 })

    const { data: item } = await client.from('order_items').select('product_id').eq('order_id', capability.order_id).eq('product_id', productId).maybeSingle()
    if (!item) return NextResponse.json({ error: 'This product is not part of the paid order.' }, { status: 403 })

    const { data: files, error: filesError } = await client
      .from('product_files')
      .select('id,original_filename,mime_type,storage_path')
      .eq('product_id', productId)
      .order('created_at', { ascending: true })
    if (filesError) return NextResponse.json({ error: 'Unable to load the purchased files.' }, { status: 500 })

    const downloads = []
    for (const file of files || []) {
      const { data: signed, error: signedError } = await client.storage.from(BUCKET).createSignedUrl(file.storage_path, SIGNED_URL_SECONDS, { download: file.original_filename })
      if (signedError || !signed?.signedUrl) return NextResponse.json({ error: 'Unable to prepare a secure download.' }, { status: 500 })
      downloads.push({ id: file.id, name: file.original_filename, mimeType: file.mime_type, url: signed.signedUrl, expiresIn: SIGNED_URL_SECONDS })
    }

    return NextResponse.json({ downloads }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Unable to prepare a secure download.' }, { status: 500 })
  }
}
