'use client'

import { useState } from 'react'
import Script from 'next/script'

declare global { interface Window { Razorpay?: new (options: Record<string, unknown>) => { open: () => void } } }

export function RazorpayCheckoutButton({ productId, productName, price, currency }: { productId: string; productName: string; price: number; currency: string }) {
  const [quantity, setQuantity] = useState(1)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function start() {
    setBusy(true); setError('')
    try {
      if (!window.Razorpay) throw new Error('Checkout is still loading. Try again.')
      const response = await fetch('/api/payments/razorpay/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId, quantity, customerName: name, customerEmail: email }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to start checkout.')
      const checkout = new window.Razorpay({ key: data.keyId, amount: data.amount, currency: data.currency, name: 'JD CreatorHub', description: productName, order_id: data.orderId, prefill: { name, email }, theme: { color: '#2563eb' }, modal: { ondismiss: () => setBusy(false) }, handler: async (result: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => { const verify = await fetch('/api/payments/razorpay/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...result, internal_order_id: data.internalOrderId }) }); if (!verify.ok) setError('Payment was received but could not be verified yet. Please contact support.'); else window.location.assign(`/p/${window.location.pathname.split('/').pop()}?paid=1`) } })
      checkout.open()
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to start checkout.'); setBusy(false) }
  }
  return <div className="mt-8 border-t border-slate-100 pt-6"><Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" /><div className="grid gap-3 sm:grid-cols-2"><input aria-label="Name" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} className="h-11 rounded-xl border border-slate-200 px-3 text-sm" /><input aria-label="Email" type="email" required placeholder="Email for receipt" value={email} onChange={e => setEmail(e.target.value)} className="h-11 rounded-xl border border-slate-200 px-3 text-sm" /></div><div className="mt-3 flex items-center gap-3"><label className="text-sm text-slate-500">Quantity<input aria-label="Quantity" type="number" min={1} max={100} value={quantity} onChange={e => setQuantity(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="ml-2 h-10 w-20 rounded-xl border border-slate-200 px-3" /></label><button type="button" onClick={start} disabled={busy || !email} className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Opening checkout…' : `Buy for ${currency} ${(price * quantity).toFixed(2)}`}</button></div>{error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}<p className="mt-3 text-xs text-slate-400">Test mode checkout. Your order is confirmed only after server verification.</p></div>
}
