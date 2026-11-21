'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { CalendarDays, Check, Clock3, MapPin, RefreshCw } from 'lucide-react'
import { displayTime } from '@/lib/bookings'

type RequestRow = { request_type: string; reason: string; requested_starts_at: string | null; status: string; created_at: string }
type Slot = { startsAt: string; label: string }
type BookingInfo = { customer_name: string; customer_email: string; customer_phone: string | null; customer_note: string | null; starts_at: string; ends_at: string; timezone: string; status: string; payment_status: string; booking_services: { name: string; description: string; location_type: string; location_details: string | null } | null }
type Payload = { booking: BookingInfo; creatorName: string; requests: RequestRow[] }

export function CustomerBookingPanel({ token }: { token: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [type, setType] = useState<'cancellation' | 'reschedule'>('cancellation')
  const [reason, setReason] = useState('')
  const [requestedDate, setRequestedDate] = useState('')
  const [requestedTime, setRequestedTime] = useState('')
  const [availableSlots, setAvailableSlots] = useState<Slot[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    const response = await fetch(`/api/bookings/customer/${encodeURIComponent(token)}`)
    if (!response.ok) { setError('This booking link is invalid or unavailable.'); return }
    setData(await response.json())
  }
  useEffect(() => { void load() }, [token])

  function updateAvailableSlots(date: string) {
    setRequestedDate(date); setRequestedTime(''); setAvailableSlots([])
    if (!date) return
    setSlotsLoading(true)
    void fetch(`/api/bookings/slots?token=${encodeURIComponent(token)}&date=${encodeURIComponent(date)}`)
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error('slots_unavailable'); setAvailableSlots(result.slots || []) })
      .catch(() => setError('Unable to load available times for that date.'))
      .finally(() => setSlotsLoading(false))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch(`/api/bookings/customer/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, reason, startsAt: type === 'reschedule' ? requestedTime : undefined }) })
      const result = await response.json()
      if (!response.ok) { setError(result.error === 'slot_taken' ? 'That time is no longer available. Please choose another time.' : result.error === 'request_pending' ? 'A request is already awaiting creator review.' : 'Unable to submit your request. Check the details and try again.'); return }
      setNotice('Your request was sent to the creator for review.')
      setReason(''); setRequestedDate(''); setRequestedTime(''); setAvailableSlots([]); await load()
    } catch { setError('Unable to reach the booking server. Please try again.') }
    finally { setBusy(false) }
  }

  if (!data) return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6"><p role="status" className="text-sm text-slate-600">{error || 'Loading your booking…'}</p></main>
  const { booking, requests } = data
  const service = booking.booking_services
  const pending = requests.some((request) => request.status === 'pending')
  const canManage = ['pending', 'confirmed'].includes(booking.status)
  return <main className="min-h-screen bg-slate-50 px-5 py-10 text-slate-950">
    <section className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-9">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600"><Check size={22} aria-hidden="true" /></div>
      <p className="mt-6 text-sm font-semibold capitalize text-emerald-700">Booking {booking.status.replaceAll('_', ' ')}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{service?.name || 'Appointment details'}</h1>
      <p className="mt-2 text-slate-500">Your appointment with {data.creatorName}.</p>
      <div className="mt-7 space-y-4 rounded-2xl bg-slate-50 p-5 text-sm">
        <p className="flex gap-3"><CalendarDays size={18} className="shrink-0 text-blue-600" aria-hidden="true" />{displayTime(booking.starts_at, booking.timezone)}</p>
        <p className="flex gap-3"><Clock3 size={18} className="shrink-0 text-blue-600" aria-hidden="true" />{booking.timezone}</p>
        <p className="flex gap-3"><MapPin size={18} className="shrink-0 text-blue-600" aria-hidden="true" />{service?.location_type === 'online' ? 'Online appointment' : service?.location_details || 'In-person appointment'}</p>
        <div className="border-t border-slate-200 pt-3"><p><span className="font-medium">Customer:</span> {booking.customer_name}</p><p className="mt-1 break-all"><span className="font-medium">Email:</span> {booking.customer_email}</p>{booking.customer_phone && <p className="mt-1"><span className="font-medium">Phone:</span> {booking.customer_phone}</p>}{booking.customer_note && <p className="mt-2"><span className="font-medium">Your note:</span> {booking.customer_note}</p>}</div>
        <p className="border-t border-slate-200 pt-3"><span className="font-medium">Payment:</span> <span className="capitalize">{booking.payment_status.replaceAll('_', ' ')}</span></p>
      </div>
      {requests.length > 0 && <section className="mt-7" aria-labelledby="request-history"><h2 id="request-history" className="font-semibold">Request history</h2><div className="mt-3 space-y-2">{requests.map((request) => <article key={`${request.created_at}-${request.request_type}`} className="rounded-xl border border-slate-200 p-4 text-sm"><p className="font-medium capitalize">{request.request_type} request · {request.status}</p><p className="mt-1 text-slate-600">Reason: {request.reason}</p>{request.requested_starts_at && <p className="mt-1 text-slate-600">Requested: {displayTime(request.requested_starts_at, booking.timezone)}</p>}</article>)}</div></section>}
      {canManage && !pending && <form onSubmit={submit} className="mt-8 border-t border-slate-200 pt-6"><h2 className="font-semibold">Manage this booking</h2><label className="mt-4 block text-sm font-medium">Request type<select value={type} onChange={(event) => setType(event.target.value as typeof type)} className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3"><option value="cancellation">Request cancellation</option><option value="reschedule">Request a new time</option></select></label>{type === 'reschedule' && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="block text-sm font-medium">Requested date<input required type="date" value={requestedDate} onChange={(event) => updateAvailableSlots(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3" /></label><label className="block text-sm font-medium">Available time ({booking.timezone})<select required disabled={!requestedDate || slotsLoading || availableSlots.length === 0} value={requestedTime} onChange={(event) => setRequestedTime(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3"><option value="">{slotsLoading ? 'Loading times…' : availableSlots.length ? 'Select a time' : 'No available times'}</option>{availableSlots.map((slot) => <option key={slot.startsAt} value={slot.startsAt}>{slot.label}</option>)}</select></label></div>}<label className="mt-3 block text-sm font-medium">Reason<textarea required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-xl border border-slate-300 p-3" placeholder="Tell the creator why you need this change." /></label>{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}{notice && <p role="status" className="mt-3 text-sm text-emerald-700">{notice}</p>}<button disabled={busy || !reason.trim()} className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Sending…' : 'Send request'}{busy ? <RefreshCw className="animate-spin" size={15} aria-hidden="true" /> : null}</button><p className="mt-3 text-xs text-slate-500">Your booking stays unchanged until the creator reviews your request.</p></form>}
      {canManage && pending && <p role="status" className="mt-7 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Your request is awaiting creator review. Your current booking remains unchanged.</p>}
    </section>
  </main>
}
