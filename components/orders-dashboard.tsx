'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Order = { id: string; customer_name: string | null; customer_email: string | null; status: string; currency: string; subtotal_minor: number; total_minor: number; created_at: string; order_items: { id: string; product_name: string; unit_price_minor: number; quantity: number; line_total_minor: number }[] }
const statuses = ['all', 'pending', 'processing', 'fulfilled', 'cancelled'] as const
const labels: Record<string, string> = { pending: 'Pending', processing: 'Processing', fulfilled: 'Fulfilled', cancelled: 'Cancelled' }

function money(amount: number, currency: string) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount / 100) }

export function OrdersDashboard() {
  const [orders, setOrders] = useState<Order[]>([])
  const [status, setStatus] = useState<(typeof statuses)[number]>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  useEffect(() => {
    let active = true
    async function load() {
      const client = createClient()
      const { data: user } = await client.auth.getUser()
      if (!user.user) { if (active) { setError('Your session expired. Please sign in again.'); setLoading(false) }; return }
      const { data: store, error: storeError } = await client.from('stores').select('id').eq('user_id', user.user.id).maybeSingle()
      if (storeError || !store) { if (active) { setError(storeError?.message || 'Create your store before viewing orders.'); setLoading(false) }; return }
      const { data, error: orderError } = await client.from('orders').select('id, customer_name, customer_email, status, currency, subtotal_minor, total_minor, created_at, order_items(id, product_name, unit_price_minor, quantity, line_total_minor)').eq('store_id', store.id).order('created_at', { ascending: false })
      if (active) { if (orderError) setError(orderError.message.includes('does not exist') ? 'Order management is not enabled yet. Apply the orders migration first.' : orderError.message); else setOrders((data as Order[]) || []); setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [])

  const visible = useMemo(() => status === 'all' ? orders : orders.filter(order => order.status === status), [orders, status])
  async function updateStatus(id: string, nextStatus: string) {
    setBusyId(id); setError('')
    const { error: updateError } = await createClient().from('orders').update({ status: nextStatus }).eq('id', id)
    if (updateError) setError(updateError.message); else setOrders(current => current.map(order => order.id === id ? { ...order, status: nextStatus } : order))
    setBusyId('')
  }

  return <div className="p-5 lg:p-8"><div className="mb-8"><h1 className="text-2xl font-semibold tracking-tight">Orders</h1><p className="mt-1 text-sm text-slate-500">Manage orders created by a future secure checkout flow.</p></div>{error && <p role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div className="mb-5 flex flex-wrap gap-2">{statuses.map(value => <button key={value} onClick={() => setStatus(value)} className={`rounded-xl px-3 py-2 text-sm font-medium ${status === value ? 'bg-slate-950 text-white' : 'border border-slate-200 bg-white text-slate-500'}`}>{value === 'all' ? 'All' : labels[value]}</button>)}</div>{loading ? <div className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">Loading orders…</div> : visible.length === 0 ? <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center"><h2 className="font-semibold">No orders yet</h2><p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Orders will appear here after a secure checkout and server-side order creation flow is enabled. No order creation is available in this phase.</p></div> : <div className="grid gap-4">{visible.map(order => <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><p className="font-semibold">{order.customer_name || order.customer_email || 'Customer'}</p><p className="mt-1 text-xs text-slate-500">{new Date(order.created_at).toLocaleString()}</p></div><div className="flex items-center gap-3"><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{labels[order.status] || order.status}</span><select aria-label={`Update order ${order.id} status`} value={order.status} disabled={busyId === order.id} onChange={event => void updateStatus(order.id, event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"><option value="pending">Pending</option><option value="processing">Processing</option><option value="fulfilled">Fulfilled</option><option value="cancelled">Cancelled</option></select></div></div><div className="mt-4 border-t border-slate-100 pt-4">{order.order_items.map(item => <div key={item.id} className="flex justify-between gap-4 py-1 text-sm"><span>{item.product_name} × {item.quantity}</span><span>{money(item.line_total_minor, order.currency)}</span></div>)}<div className="mt-3 flex justify-between border-t border-slate-100 pt-3 font-semibold"><span>Total</span><span>{money(order.total_minor, order.currency)}</span></div></div></article>)}</div>}</div>
}
