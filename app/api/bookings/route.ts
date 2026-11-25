import { after, NextResponse } from 'next/server'
import { deliverBookingNotificationsForBooking } from '@/lib/booking-email-delivery'
import { createClient } from '@/lib/supabase/server'
import { createBookingPaymentAdminClient } from '@/lib/booking-payment-server'

const transitions: Record<string, string[]> = { pending: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled', 'no_show'], cancelled: [], completed: [], no_show: [] }
async function auth() { const client = await createClient(); const { data: { user } } = await client.auth.getUser(); return { client, user } }
export async function GET() {
  const { client, user } = await auth()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: services, error: servicesError } = await client.from('booking_services').select('id').eq('creator_id', user.id)
  if (servicesError) return NextResponse.json({ error: 'Unable to refresh booking status.' }, { status: 500 })
  try {
    const admin = createBookingPaymentAdminClient()
    const expiries = await Promise.all((services || []).map((service) => admin.rpc('expire_booking_payment_holds', { p_service_id: service.id })))
    if (expiries.some((result) => result.error)) return NextResponse.json({ error: 'Unable to refresh booking status.' }, { status: 503 })
  } catch {
    return NextResponse.json({ error: 'Unable to refresh booking status.' }, { status: 503 })
  }

  const { data, error } = await client.from('bookings')
    .select('*,booking_services(name,slug,duration_minutes,currency,price_minor,timezone),booking_payments(provider_payment_id,amount_minor,currency,status,failure_reason,expires_at,captured_at,created_at),booking_notifications(id,notification_type,status,attempt_count,last_error,scheduled_for,sent_at),booking_change_requests(id,request_type,reason,requested_starts_at,status,created_at)')
    .eq('creator_id', user.id).order('starts_at', { ascending: true })
  return error ? NextResponse.json({ error: 'Unable to load bookings.' }, { status: 500 }) : NextResponse.json({ bookings: data || [] })
}
export async function PATCH(request: Request) { const { client, user } = await auth(); if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); let body: { id?: string; status?: string; internalNote?: string }; try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON request.' }, { status: 400 }) } if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id)) return NextResponse.json({ error: 'A valid booking ID is required.' }, { status: 400 }); if (!body.status || !['pending','confirmed','cancelled','completed','no_show'].includes(body.status)) return NextResponse.json({ error: 'Invalid booking status.' }, { status: 400 }); const { data: current, error: lookupError } = await client.from('bookings').select('id,status,payment_status,price_minor').eq('id', body.id).eq('creator_id', user.id).maybeSingle(); if (lookupError) return NextResponse.json({ error: 'Unable to verify booking ownership.' }, { status: 500 }); if (!current) return NextResponse.json({ error: 'Booking not found.' }, { status: 404 }); if (current.status === body.status) return NextResponse.json({ error: `Booking is already ${body.status}.` }, { status: 409 }); if (body.status === 'confirmed' && Number(current.price_minor) > 0 && current.payment_status !== 'captured') return NextResponse.json({ error: 'Paid appointments can only be confirmed after verified payment capture.' }, { status: 409 }); if (!transitions[current.status]?.includes(body.status)) return NextResponse.json({ error: `Cannot change a ${current.status} booking to ${body.status}.` }, { status: 409 }); const updates: Record<string, string | null> = { status: body.status }; if (body.status === 'cancelled') updates.cancelled_at = new Date().toISOString(); if (typeof body.internalNote === 'string') updates.internal_note = body.internalNote.trim(); const { data, error } = await client.from('bookings').update(updates).eq('id', body.id).eq('creator_id', user.id).select('*,booking_services(name,slug,duration_minutes,currency,price_minor,timezone),booking_payments(provider_payment_id,amount_minor,currency,status,failure_reason,expires_at,captured_at,created_at),booking_notifications(id,notification_type,status,attempt_count,last_error,scheduled_for,sent_at),booking_change_requests(id,request_type,reason,requested_starts_at,status,created_at)').single(); if (error) { console.error('[bookings] status update failed', { bookingId: body.id, code: error.code }); return NextResponse.json({ error: 'Unable to update booking status.' }, { status: 500 }) } if (body.status === 'confirmed' || body.status === 'cancelled') { const notificationType = body.status === 'confirmed' ? 'creator_confirmation' : 'creator_cancellation'; try { after(async () => { try { await deliverBookingNotificationsForBooking(body.id!, [notificationType]) } catch { console.error('[booking-email] status notification dispatch failed', { bookingId: body.id, notificationType }) } }) } catch { console.error('[booking-email] status callback could not be scheduled', { bookingId: body.id, notificationType }) } } return NextResponse.json({ booking: data }) }
