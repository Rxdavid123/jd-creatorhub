'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { CalendarDays, Clock3, Copy, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { BOOKING_CURRENCIES, formatMinorAmount, parseMajorAmount } from '@/lib/booking-currency'

type Service = {
  id: string
  name: string
  slug: string
  description: string
  duration_minutes: number
  price_minor: number
  currency: string
  status: string
  timezone: string
}

type BookingPayment = { provider_payment_id: string | null; amount_minor: number; currency: string; status: string; failure_reason: string | null; expires_at: string; captured_at: string | null; created_at: string }

type BookingNotification = {
  id: string
  notification_type: string
  status: string
  attempt_count: number
  last_error: string | null
  scheduled_for: string
  sent_at: string | null
}

type BookingChangeRequest = { id: string; request_type: 'cancellation' | 'reschedule'; reason: string; requested_starts_at: string | null; status: string; created_at: string }

type Booking = {
  id: string
  customer_name: string
  customer_email: string
  customer_phone?: string | null
  customer_note?: string | null
  starts_at: string
  timezone: string
  status: string
  payment_status: string
  payment_expires_at: string | null
  price_minor: number
  currency: string
  booking_services?: { name: string; timezone: string } | { name: string; timezone: string }[]
  booking_payments?: BookingPayment[]
  booking_notifications?: BookingNotification[]
  booking_change_requests?: BookingChangeRequest[]
}

type Form = {
  name: string
  slug: string
  description: string
  duration_minutes: string
  price: string
  currency: string
  timezone: string
  location_type: string
  location_details: string
}

const empty: Form = {
  name: '',
  slug: '',
  description: '',
  duration_minutes: '30',
  price: '0.00',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  location_type: 'online',
  location_details: '',
}

const emailNotificationLabels: Record<string, string> = {
  confirmation: 'Customer booking confirmation',
  new_booking: 'Creator booking alert',
  creator_confirmation: 'Customer confirmation update',
  creator_cancellation: 'Booking cancellation update',
  change_request_submitted: 'Customer change request',
  change_request_decision: 'Customer request decision',
}

function formatBookingDateTime(startsAt: string, timezone: string) {
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return startsAt

  try {
    const dateLabel = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: timezone,
    }).format(date)
    const timeLabel = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    }).format(date)
    return `${dateLabel} at ${timeLabel} (${timezone})`
  } catch {
    return date.toLocaleString()
  }
}

function notificationStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: 'Queued',
    sending: 'Sending',
    sent: 'Accepted by email provider',
    failed: 'Needs attention',
    not_configured: 'Not configured',
  }
  return labels[status] ?? 'Unknown'
}

function notificationErrorMessage(error: string | null) {
  if (!error) return null
  if (error === 'provider_configuration_missing') return 'Email provider or sender address is not configured.'
  if (error === 'creator_email_unavailable') return 'No creator email address is available for this account.'
  if (error === 'provider_timeout' || error === 'provider_network_error') return 'The email provider could not be reached.'
  if (error === 'provider_http_429') return 'The email provider is rate-limiting requests. Retry shortly.'
  if (error.startsWith('provider_http_')) return 'The email provider rejected this message.'
  if (error === 'superseded_by_newer_booking_status') return 'Not sent because a newer booking status is already in effect.'
  if (error === 'retry_limit_reached') return 'The automatic retry limit has been reached.'
  return 'The email could not be accepted. You can retry it after resolving the issue.'
}

function canRetryNotification(notification: BookingNotification) {
  if (notification.attempt_count >= 5 || notification.last_error === 'superseded_by_newer_booking_status') return false
  if (notification.status === 'pending' || notification.status === 'failed') return true
  return notification.status === 'sending'
    && Date.now() - Date.parse(notification.scheduled_for) > 10 * 60 * 1000
}

export default function BookingsDashboard() {
  const [services, setServices] = useState<Service[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [notificationBusy, setNotificationBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [storeUsername, setStoreUsername] = useState('')
  const [form, setForm] = useState(empty)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const [servicesResponse, bookingsResponse] = await Promise.all([
        fetch('/api/bookings/services'),
        fetch('/api/bookings'),
      ])
      const servicesData = await servicesResponse.json()
      const bookingsData = await bookingsResponse.json()
      setServices(servicesData.services || [])
      setStoreUsername(servicesData.storeUsername || '')
      setBookings(bookingsData.bookings || [])
      if (!servicesResponse.ok || !bookingsResponse.ok) {
        setError(servicesData.error || bookingsData.error || 'Unable to load bookings.')
      } else {
        setError('')
      }
    } catch {
      setError('Unable to load bookings. Please try again.')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    const priceMinor = parseMajorAmount(form.price, form.currency)
    if (priceMinor === null) {
      setError('Enter a valid price with up to two decimal places.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/bookings/services', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...form,
          id: editing,
          price_minor: priceMinor,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error || 'Unable to save service.')
        return
      }
      setForm(empty)
      setEditing(null)
      await load()
    } catch {
      setError('Unable to reach the booking server.')
    } finally {
      setBusy(false)
    }
  }

  function edit(service: Service) {
    setEditing(service.id)
    setForm({
      name: service.name,
      slug: service.slug,
      description: service.description,
      duration_minutes: String(service.duration_minutes),
      price: (service.price_minor / 100).toFixed(2),
      currency: service.currency,
      timezone: service.timezone,
      location_type: 'online',
      location_details: '',
    })
  }

  async function action(id: string, status: string) {
    setActionBusy(id)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/bookings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, status }),
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error || 'Unable to update booking.')
        return
      }
      setNotice(status === 'confirmed'
        ? 'Booking confirmed.'
        : status === 'cancelled'
          ? 'Booking cancelled.'
          : 'Booking marked completed.')
      await load()
    } catch {
      setError('Unable to reach the booking server.')
    } finally {
      setActionBusy(null)
    }
  }

  async function decideRequest(requestId: string, decision: 'approved' | 'rejected') {
    setActionBusy(requestId); setError(''); setNotice('')
    try {
      const response = await fetch('/api/bookings/customer/manage', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, decision }) })
      const data = await response.json()
      if (!response.ok) { setError(data.error || 'Unable to update request.'); return }
      setNotice(`Request ${decision}.`)
      await load()
    } catch { setError('Unable to reach the booking server.') }
    finally { setActionBusy(null) }
  }

  async function retryNotification(notificationId: string) {
    setNotificationBusy(notificationId)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/bookings/notifications/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notificationId }),
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error || 'Unable to retry this email.')
        return
      }
      setNotice(data.status === 'sent'
        ? 'Email accepted by the provider.'
        : data.status === 'sending'
          ? 'An email attempt is already in progress.'
          : 'Email status updated. Review the booking notification details.')
      await load()
    } catch {
      setError('Unable to reach the email delivery service.')
    } finally {
      setNotificationBusy(null)
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete or archive this service?')) return
    await fetch('/api/bookings/services', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    await load()
  }

  async function togglePublished(service: Service) {
    await fetch('/api/bookings/services', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: service.id,
        status: service.status === 'published' ? 'draft' : 'published',
        name: service.name,
        slug: service.slug,
        description: service.description,
        duration_minutes: service.duration_minutes,
        price_minor: service.price_minor,
        currency: service.currency,
        timezone: service.timezone,
        location_type: 'online',
      }),
    })
    await load()
  }

  return (
    <main className="min-h-screen bg-[#f8faff] p-5 text-slate-950 lg:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-500">Bookings</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Appointments</h1>
            <p className="mt-2 text-sm text-slate-500">Offer time with your audience and keep every appointment organized.</p>
          </div>
          <a href="/dashboard/bookings/availability" className="inline-flex h-10 items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:self-auto"><Clock3 size={15} aria-hidden="true" />Manage availability</a>
        </header>

        {notice && <p role="status" className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
        {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

        <section aria-label="Booking summary" className="mt-8 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">Services</p>
            <p className="mt-3 text-3xl font-semibold">{services.length}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">Upcoming</p>
            <p className="mt-3 text-3xl font-semibold">{bookings.filter((booking) => new Date(booking.starts_at) > new Date() && !['cancelled', 'expired'].includes(booking.status)).length}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">Needs attention</p>
            <p className="mt-3 text-3xl font-semibold">{bookings.filter((booking) => booking.status === 'pending').length}</p>
          </div>
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
          <form onSubmit={save} className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{editing ? 'Edit service' : 'Create service'}</h2>
              {editing && <button type="button" onClick={() => { setEditing(null); setForm(empty) }} className="text-sm text-slate-500">Cancel</button>}
            </div>
            <label className="mt-4 block text-sm font-medium">Service name
              <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Service name" className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" />
            </label>
            <label className="mt-3 block text-sm font-medium">Booking link slug
              <input required value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="service-slug" className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" />
            </label>
            <label className="mt-3 block text-sm font-medium">Description
              <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Description" className="mt-2 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm" />
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="text-sm font-medium">Minutes
                <input type="number" min="5" value={form.duration_minutes} onChange={(event) => setForm({ ...form, duration_minutes: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3" />
              </label>
              <label className="text-sm font-medium">Price
                <input aria-label="Service price" type="number" min="0" step="0.01" inputMode="decimal" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3" />
              </label>
              <label className="text-sm font-medium">Currency
                <select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3">
                  {BOOKING_CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </label>
            </div>
            <button disabled={busy} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-500 text-sm font-semibold text-white disabled:opacity-50">
              {editing ? 'Save service' : 'Create service'} <Plus size={15} aria-hidden="true" />
            </button>
          </form>

          <div className="space-y-3">
            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="font-semibold">Your services</h2>
              {!services.length && <p className="mt-4 text-sm text-slate-500">Create your first appointment service.</p>}
              {services.map((service) => (
                <article key={service.id} className="mt-4 flex flex-col items-start justify-between gap-3 rounded-xl border border-slate-100 p-4 sm:flex-row sm:items-center">
                  <div>
                    <p className="font-semibold">{service.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{service.duration_minutes} min · {formatMinorAmount(service.price_minor, service.currency)} · {service.price_minor === 0 ? 'Free' : 'Paid'} · {service.status}</p>
                    {service.status === 'published' && <p className="mt-1 break-all font-mono text-xs text-blue-600">/book/{storeUsername}/{service.slug}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => edit(service)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">Edit</button>
                    <button type="button" onClick={() => void togglePublished(service)} className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">{service.status === 'published' ? 'Unpublish' : 'Publish'}</button>
                    {service.status === 'published' && <>
                      <button type="button" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/book/${storeUsername}/${service.slug}`); setNotice('Booking link copied.') }} className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white"><Copy size={13} aria-hidden="true" />Copy link</button>
                      <a href={`/book/${storeUsername}/${service.slug}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs"><ExternalLink size={13} aria-hidden="true" />View</a>
                    </>}
                    <button type="button" onClick={() => void remove(service.id)} className="rounded-lg p-2 text-slate-400 hover:text-red-600" aria-label={`Delete ${service.name}`}><Trash2 size={15} aria-hidden="true" /></button>
                  </div>
                </article>
              ))}
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-center gap-2">
                <CalendarDays size={18} className="text-blue-500" aria-hidden="true" />
                <h2 className="font-semibold">Bookings</h2>
              </div>
              {!bookings.length && <p className="mt-4 text-sm text-slate-500">Confirmed appointments will appear here.</p>}
              <div className="mt-3 space-y-3">
                {bookings.map((booking) => {
                  const serviceRelation = booking.booking_services
                  const service = Array.isArray(serviceRelation) ? serviceRelation[0] : serviceRelation
                          const notifications = (booking.booking_notifications || []).filter((notification) => notification.notification_type in emailNotificationLabels)
                          const latestPayment = [...(booking.booking_payments || [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]

                          return (
                    <article key={booking.id} className="rounded-xl border border-slate-100 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="font-semibold">{booking.customer_name}</p>
                          <p className="mt-1 text-xs text-slate-500">{service?.name || 'Appointment'} · {formatBookingDateTime(booking.starts_at, booking.timezone || service?.timezone || 'UTC')}</p>
                          <a href={`mailto:${booking.customer_email}`} className="mt-1 inline-block break-all text-xs text-blue-700 underline">{booking.customer_email}</a>
                          {booking.customer_phone && <p className="mt-1 text-xs text-slate-600">{booking.customer_phone}</p>}
                          {booking.customer_note && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{booking.customer_note}</p>}
                          <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
                            <p><span className="font-semibold">Service type:</span> {booking.price_minor > 0 ? 'Paid' : 'Free'}</p>
                            <p className="mt-1"><span className="font-semibold">Amount:</span> {booking.price_minor > 0 ? formatMinorAmount(booking.price_minor, booking.currency) : 'No charge'}</p>
                            <p className="mt-1"><span className="font-semibold">Payment status:</span> {booking.payment_status === 'not_required' ? 'Not required' : booking.payment_status === 'captured' ? 'Paid' : booking.payment_status.replaceAll('_', ' ')}</p>
                            {latestPayment?.provider_payment_id && <p className="mt-1 break-all"><span className="font-semibold">Razorpay payment reference:</span> <span className="font-mono">{latestPayment.provider_payment_id}</span></p>}
                            {booking.payment_status === 'failed' && booking.payment_expires_at && <p className="mt-1 text-amber-800">Payment attempt failed. Retry is available until {new Date(booking.payment_expires_at).toLocaleString()}.</p>}
                            {booking.payment_status === 'expired' && <p className="mt-1 text-amber-800">The unpaid reservation expired and the slot is available again.</p>}
                            {booking.payment_status === 'captured' && <p className="mt-1 text-slate-500">Approving a cancellation does not automatically issue a refund.</p>}
                            {booking.payment_status === 'captured' && booking.status === 'expired' && <p className="mt-1 text-amber-800">Payment was captured but the appointment could not be confirmed; follow up with the customer. No automatic refund was issued.</p>}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs">{booking.status}</span>
                          {booking.status === 'pending' && booking.price_minor === 0 && <button type="button" disabled={actionBusy === booking.id} onClick={() => void action(booking.id, 'confirmed')} className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{actionBusy === booking.id ? 'Confirming…' : 'Confirm'}</button>}
                          {booking.status === 'pending' && booking.price_minor > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800">Awaiting verified payment</span>}
                          {booking.status === 'confirmed' && <button type="button" disabled={actionBusy === booking.id} onClick={() => void action(booking.id, 'completed')} className="rounded-lg border border-slate-200 px-3 py-2 text-xs disabled:opacity-50">Complete</button>}
                          {['pending', 'confirmed'].includes(booking.status) && <button type="button" disabled={actionBusy === booking.id} onClick={() => void action(booking.id, 'cancelled')} className="rounded-lg border border-red-200 px-3 py-2 text-xs text-red-600 disabled:opacity-50">Cancel</button>}
                        </div>
                      </div>

                      {(booking.booking_change_requests || []).filter((request) => request.status === 'pending').map((request) => (
                        <section key={request.id} className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4" aria-label="Pending customer request">
                          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold capitalize">Customer {request.request_type} request</h3><p className="mt-1 text-sm text-slate-700">Reason: {request.reason}</p><p className="mt-1 text-xs text-slate-600">Current time: {formatBookingDateTime(booking.starts_at, booking.timezone || 'UTC')}</p>{request.requested_starts_at && <p className="mt-1 text-xs text-slate-600">Requested time: {formatBookingDateTime(request.requested_starts_at, booking.timezone || 'UTC')}</p>}</div><div className="flex gap-2"><button type="button" disabled={actionBusy === request.id} onClick={() => void decideRequest(request.id, 'approved')} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Approve</button><button type="button" disabled={actionBusy === request.id} onClick={() => void decideRequest(request.id, 'rejected')} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold disabled:opacity-50">Reject</button></div></div>
                        </section>
                      ))}

                      <div className="mt-4 border-t border-slate-100 pt-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email notifications</h3>
                        {notifications.length === 0 && <p className="mt-2 text-xs text-slate-500">No notification records for this booking.</p>}
                        <ul className="mt-2 space-y-2">
                          {notifications.map((notification) => {
                            const retryable = canRetryNotification(notification)
                            const detail = notificationErrorMessage(notification.last_error)
                            return (
                              <li key={notification.id} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                  <p className="text-sm font-medium">{emailNotificationLabels[notification.notification_type]}</p>
                                  <p role="status" className="mt-1 text-xs text-slate-600">{notificationStatusLabel(notification.status)} · attempt {notification.attempt_count} of 5</p>
                                  {notification.sent_at && <p className="mt-1 text-xs text-slate-500">Provider accepted at {new Date(notification.sent_at).toLocaleString()}</p>}
                                  {detail && <p className="mt-1 text-xs text-amber-800">{detail}</p>}
                                </div>
                                {retryable && <button
                                  type="button"
                                  disabled={notificationBusy === notification.id}
                                  onClick={() => void retryNotification(notification.id)}
                                  aria-label={`${notification.status === 'pending' ? 'Send' : 'Retry'} ${emailNotificationLabels[notification.notification_type]}`}
                                  className="self-start rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-semibold text-blue-700 disabled:opacity-50 sm:self-center"
                                >
                                  {notificationBusy === notification.id ? 'Sending…' : notification.status === 'pending' ? 'Send email' : 'Retry email'}
                                </button>}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}
