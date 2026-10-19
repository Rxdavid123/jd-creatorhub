import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
const allowedStatuses = new Set(['pending', 'processing', 'fulfilled', 'cancelled'])

type ItemInput = { productId: string; quantity: number }

export async function POST(request: Request) {
  const authClient = await createServerClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })

  const body = await request.json().catch(() => null) as { customerName?: unknown; customerEmail?: unknown; items?: unknown } | null
  const items = Array.isArray(body?.items) ? body.items as ItemInput[] : []
  if (items.length === 0 || items.length > 50) return NextResponse.json({ error: 'Add between 1 and 50 products.' }, { status: 400 })

  const normalized = items.map(item => ({ productId: String(item.productId), quantity: Number(item.quantity) }))
  if (normalized.some(item => !/^[0-9a-f-]{36}$/i.test(item.productId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100)) {
    return NextResponse.json({ error: 'Each product must have a valid quantity from 1 to 100.' }, { status: 400 })
  }

  const { data: orderId, error } = await authClient.rpc('create_manual_order', {
    p_customer_name: typeof body?.customerName === 'string' ? body.customerName : null,
    p_customer_email: typeof body?.customerEmail === 'string' ? body.customerEmail : null,
    p_items: normalized,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ id: orderId }, { status: 201 })
}

export async function PATCH(request: Request) {
  const authClient = await createServerClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const body = await request.json().catch(() => null) as { orderId?: unknown; status?: unknown } | null
  if (typeof body?.orderId !== 'string' || typeof body.status !== 'string' || !allowedStatuses.has(body.status)) return NextResponse.json({ error: 'Invalid order status update.' }, { status: 400 })
  const { error } = await authClient.from('orders').update({ status: body.status }).eq('id', body.orderId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
