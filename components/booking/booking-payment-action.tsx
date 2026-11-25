'use client'

import { useState } from 'react'
import Script from 'next/script'
import { formatMinorAmount } from '@/lib/booking-currency'

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

type BookingPaymentActionProps = {
  bookingToken: string
  serviceName: string
  customerName: string
  customerEmail: string
  amountMinor: number
  currency: string
  paymentExpiresAt: string | null
  onRefresh?: () => void
}

type CheckoutResponse = { keyId: string; orderId: string; amount: number; currency: string }

type RazorpayResult = {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

export function BookingPaymentAction({
  bookingToken,
  serviceName,
  customerName,
  customerEmail,
  amountMinor,
  currency,
  paymentExpiresAt,
  onRefresh,
}: BookingPaymentActionProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function startPayment() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!window.Razorpay) throw new Error('Secure checkout is loading. Please try again.')
      const response = await fetch('/api/bookings/payments/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bookingToken }),
      })
      const checkout = await response.json() as CheckoutResponse & { error?: string }
      if (!response.ok) {
        if (response.status === 410) onRefresh?.()
        throw new Error(checkout.error || 'Unable to start payment.')
      }

      const razorpay = new window.Razorpay({
        key: checkout.keyId,
        amount: checkout.amount,
        currency: checkout.currency,
        name: 'JD CreatorHub',
        description: serviceName,
        order_id: checkout.orderId,
        prefill: { name: customerName, email: customerEmail },
        theme: { color: '#2563eb' },
        modal: {
          ondismiss: () => {
            setBusy(false)
            setNotice('Checkout closed. Your appointment is still awaiting payment; retry before the reservation expires.')
          },
        },
        handler: async (result: RazorpayResult) => {
          try {
            setNotice('Payment received. Verifying the captured payment securely…')
            const verification = await fetch('/api/bookings/payments/verify', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ bookingToken, ...result }),
            })
            const verified = await verification.json().catch(() => null)
            if (!verification.ok) {
              onRefresh?.()
              throw new Error(verified?.error || 'Payment could not be verified. Retry safely or contact the creator.')
            }
            const destination = typeof verified?.confirmationUrl === 'string' && verified.confirmationUrl.startsWith('/booking/')
              ? verified.confirmationUrl
              : `/booking/${encodeURIComponent(bookingToken)}`
            window.location.assign(destination)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Payment could not be verified. Retry safely or contact the creator.')
            setBusy(false)
          }
        },
      })
      razorpay.open()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start payment.')
      setBusy(false)
    }
  }

  return <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4">
    <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" />
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-semibold text-slate-900">Payment required</p>
        <p className="mt-1 text-sm text-slate-600">{formatMinorAmount(amountMinor, currency)} · Test Mode checkout</p>
        {paymentExpiresAt && <p className="mt-1 text-xs text-slate-500">Reservation expires {new Date(paymentExpiresAt).toLocaleString()}.</p>}
      </div>
      <button type="button" onClick={() => void startPayment()} disabled={busy} className="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? 'Opening secure checkout…' : `Pay ${formatMinorAmount(amountMinor, currency)}`}
      </button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-blue-800">{notice}</p>}
  </div>
}
