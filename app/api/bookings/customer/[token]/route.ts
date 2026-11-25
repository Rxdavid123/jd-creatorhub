import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { deliverBookingNotificationsForBooking } from '@/lib/booking-email-delivery'

function adminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Booking server configuration is missing.')
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

function safeError(error: { message?: string }) {
  const message = error.message || ''
  const known = ['booking_not_found', 'booking_not_active', 'request_pending', 'request_not_pending', 'request_not_found', 'not_owner', 'invalid_request', 'outside_booking_window', 'outside_availability', 'blocked_date', 'blocked_time', 'slot_taken']
  return known.find((code) => message.includes(code)) || 'request_failed'
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params
  if (!/^[a-f0-9]{48}$/i.test(token)) return NextResponse.json({ error: 'Booking not found.' }, { status: 404 })
  const client = adminClient()
  let { data: booking, error } = await client.from('bookings')
    .select('id,service_id,customer_name,customer_email,customer_phone,customer_note,starts_at,ends_at,timezone,status,payment_status,payment_expires_at,price_minor,currency,booking_services(name,description,duration_minutes,location_type,location_details,creator_id)')
    .eq('public_token', token).maybeSingle()
  if (error || !booking) return NextResponse.json({ error: 'Booking not found.' }, { status: 404 })
  if (booking.status === 'pending' && booking.payment_expires_at && Date.parse(booking.payment_expires_at) <= Date.now()) {
    const { error: expiryError } = await client.rpc('expire_booking_payment_holds', { p_service_id: booking.service_id })
    if (expiryError) return NextResponse.json({ error: 'Unable to refresh this booking.' }, { status: 503 })
    const refreshed = await client.from('bookings').select('id,service_id,customer_name,customer_email,customer_phone,customer_note,starts_at,ends_at,timezone,status,payment_status,payment_expires_at,price_minor,currency,booking_services(name,description,duration_minutes,location_type,location_details,creator_id)').eq('public_token', token).maybeSingle()
    if (refreshed.error || !refreshed.data) return NextResponse.json({ error: 'Booking not found.' }, { status: 404 })
    booking = refreshed.data
  }
  const [{ data: requests }, { data: latestPayment }] = await Promise.all([
    client.from('booking_change_requests').select('request_type,reason,requested_starts_at,status,created_at,decided_at').eq('booking_id', booking.id).order('created_at', { ascending: false }).limit(5),
    client.from('booking_payments').select('status,failure_reason,expires_at').eq('booking_id', booking.id).order('attempt_number', { ascending: false }).limit(1).maybeSingle(),
  ])
  const relation = booking.booking_services
  const service = Array.isArray(relation) ? relation[0] : relation
  let creatorName = 'Your creator'
  if (service?.creator_id) {
    const { data } = await client.auth.admin.getUserById(service.creator_id)
    const metadata = data.user?.user_metadata || {}
    if (typeof metadata.full_name === 'string') creatorName = metadata.full_name
    else if (typeof metadata.name === 'string') creatorName = metadata.name
  }
  const paymentMessage = latestPayment?.status === 'failed'
    ? 'Payment failed. Retry while the reservation is active.'
    : latestPayment?.status === 'expired' || booking.payment_status === 'expired'
      ? 'The payment reservation has expired.'
      : null
  return NextResponse.json({
    booking: {
      customer_name: booking.customer_name,
      customer_email: booking.customer_email,
      customer_phone: booking.customer_phone,
      customer_note: booking.customer_note,
      starts_at: booking.starts_at,
      ends_at: booking.ends_at,
      timezone: booking.timezone,
      status: booking.status,
      payment_status: booking.payment_status,
      payment_expires_at: booking.payment_expires_at,
      price_minor: Number(booking.price_minor),
      currency: booking.currency,
      latest_payment_status: latestPayment?.status || null,
      payment_message: paymentMessage,
      booking_services: service ? {
        name: service.name,
        description: service.description,
        duration_minutes: service.duration_minutes,
        location_type: service.location_type,
        location_details: service.location_details,
      } : null,
    },
    creatorName,
    requests: requests || [],
  })
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params
  if (!/^[a-f0-9]{48}$/i.test(token)) return NextResponse.json({ error: 'Booking not found.' }, { status: 404 })
  let body: { type?: string; reason?: string; startsAt?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }
  const type = body.type
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!['cancellation', 'reschedule'].includes(type || '') || !reason || reason.length > 1000) return NextResponse.json({ error: 'Choose a request type and provide a reason of at most 1,000 characters.' }, { status: 400 })
  const requestedAt = type === 'reschedule' && typeof body.startsAt === 'string' && !Number.isNaN(Date.parse(body.startsAt)) ? new Date(body.startsAt).toISOString() : null
  if (type === 'reschedule' && !requestedAt) return NextResponse.json({ error: 'Choose a valid requested date and time.' }, { status: 400 })
  const client = adminClient()
  const { data, error } = await client.rpc('submit_booking_change_request', { p_token: token, p_request_type: type, p_reason: reason, p_requested_starts_at: requestedAt })
  if (error) return NextResponse.json({ error: safeError(error) }, { status: error.message.includes('booking_not_found') ? 404 : 409 })
  const result = data as { booking_id: string }
  await deliverBookingNotificationsForBooking(result.booking_id, ['change_request_submitted'])
  return NextResponse.json({ request: data }, { status: 201 })
}

export async function PATCH(request: Request) {
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  let body: { requestId?: string; decision?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }
  if (!body.requestId || !/^[0-9a-f-]{36}$/i.test(body.requestId) || !['approved', 'rejected'].includes(body.decision || '')) return NextResponse.json({ error: 'A valid request and decision are required.' }, { status: 400 })
  const client = adminClient()
  const { data, error } = await client.rpc('decide_booking_change_request', { p_request_id: body.requestId, p_creator_id: user.id, p_decision: body.decision })
  if (error) return NextResponse.json({ error: safeError(error) }, { status: error.message.includes('not_owner') ? 403 : 409 })
  const result = data as { booking_id: string }
  await deliverBookingNotificationsForBooking(result.booking_id, ['change_request_decision'])
  return NextResponse.json({ request: data })
}
