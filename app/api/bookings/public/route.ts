import { NextResponse } from 'next/server'
import { zonedDateTimeToUtc, bookingEmailPattern } from '@/lib/bookings'
import { createClient } from '@/lib/supabase/server'

function errorResponse(code: string, error: string, status: number) {
  return NextResponse.json({ code, error }, { status })
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export async function GET(request: Request) {
  const client = await createClient()
  const url = new URL(request.url)
  const username = url.searchParams.get('username')
  const slug = url.searchParams.get('slug')
  if (!username || !slug) return NextResponse.json({ error: 'username and slug are required.' }, { status: 400 })

  const { data: store } = await client.from('stores').select('id,store_name,username')
    .eq('username', username).eq('is_published', true).maybeSingle()
  if (!store) return NextResponse.json({ error: 'Service not found.' }, { status: 404 })

  const { data: service, error } = await client.from('booking_services')
    .select('id,store_id,slug,name,description,image_path,duration_minutes,buffer_minutes,price_minor,currency,location_type,location_details,min_notice_minutes,max_advance_days,cancellation_notice_hours,timezone,status')
    .eq('store_id', store.id).eq('slug', slug).eq('status', 'published').maybeSingle()
  return error || !service
    ? NextResponse.json({ error: 'Service not found.' }, { status: 404 })
    : NextResponse.json({ store, service })
}

export async function POST(request: Request) {
  const parsed: unknown = await request.json().catch(() => null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[bookings] public request rejected', { category: 'invalid_json' })
    return errorResponse('INVALID_REQUEST', 'Please submit a valid booking request.', 400)
  }

  const body = parsed as Record<string, unknown>
  const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : ''
  const customerEmail = typeof body.customerEmail === 'string' ? body.customerEmail.trim() : ''
  if (!customerName) {
    console.warn('[bookings] public request rejected', { category: 'missing_name' })
    return errorResponse('MISSING_NAME', 'Please enter your name.', 400)
  }
  if (!customerEmail) {
    console.warn('[bookings] public request rejected', { category: 'missing_email' })
    return errorResponse('MISSING_EMAIL', 'Please enter your email address.', 400)
  }
  if (!bookingEmailPattern.test(customerEmail)) {
    console.warn('[bookings] public request rejected', { category: 'invalid_email' })
    return errorResponse('INVALID_EMAIL', 'Please enter a valid email address.', 400)
  }
  if (customerName.length > 160 || customerEmail.length > 320) {
    console.warn('[bookings] public request rejected', { category: 'customer_field_too_long' })
    return errorResponse('INVALID_CUSTOMER', 'Please check your name and email address.', 400)
  }

  const serviceId = typeof body.serviceId === 'string' ? body.serviceId : ''
  const date = typeof body.date === 'string' ? body.date : ''
  const startTime = typeof body.startTime === 'string' ? body.startTime : ''
  const timezone = typeof body.timezone === 'string' ? body.timezone : ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(serviceId)
    || !isCalendarDate(date)
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)
    || !timezone
  ) {
    console.warn('[bookings] public request rejected', { category: 'invalid_appointment' })
    return errorResponse('INVALID_APPOINTMENT', 'Please choose a valid service, date, and available time.', 400)
  }

  const client = await createClient()
  const { data: service, error: serviceError } = await client.from('booking_services')
    .select('id,timezone').eq('id', serviceId).eq('status', 'published').maybeSingle()
  if (serviceError) {
    console.error('[bookings] service lookup failed', { category: 'service_lookup', code: serviceError.code })
    return errorResponse('SERVICE_LOOKUP_FAILED', 'We could not verify this service. Please try again.', 500)
  }
  if (!service) return errorResponse('SERVICE_UNAVAILABLE', 'This service is no longer available.', 404)
  if (timezone !== service.timezone) {
    console.warn('[bookings] public request rejected', { category: 'timezone_mismatch' })
    return errorResponse('INVALID_APPOINTMENT', 'Please refresh the page and choose an available time.', 400)
  }

  let startsAt: string
  try {
    startsAt = zonedDateTimeToUtc(date, startTime, service.timezone).toISOString()
  } catch {
    console.warn('[bookings] public request rejected', { category: 'invalid_local_datetime' })
    return errorResponse('INVALID_APPOINTMENT', 'Please choose a valid service, date, and available time.', 400)
  }

  const phone = typeof body.customerPhone === 'string' ? body.customerPhone.trim() : ''
  const note = typeof body.customerNote === 'string' ? body.customerNote.trim() : ''
  try {
    const { data, error } = await client.rpc('create_public_booking', {
      p_service_id: serviceId,
      p_starts_at: startsAt,
      p_customer_name: customerName,
      p_customer_email: customerEmail,
      p_customer_phone: phone || null,
      p_customer_note: note || null,
    })

    if (error) {
      const sqlMessage = error.message.trim()
      const knownErrors: Record<string, { code: string; message: string; status: number }> = {
        service_unavailable: { code: 'SERVICE_UNAVAILABLE', message: 'This service is no longer available.', status: 404 },
        invalid_customer: { code: 'INVALID_CUSTOMER', message: 'Please check your name and email address.', status: 400 },
        outside_booking_window: { code: 'OUTSIDE_BOOKING_WINDOW', message: 'Choose a time within the booking window.', status: 400 },
        outside_availability: { code: 'OUTSIDE_AVAILABILITY', message: 'That time is outside working hours.', status: 400 },
        blocked_date: { code: 'BLOCKED_DATE', message: 'That date is unavailable.', status: 400 },
        blocked_time: { code: 'BLOCKED_TIME', message: 'That time is blocked.', status: 400 },
        slot_taken: { code: 'SLOT_CONFLICT', message: 'That time was just booked. Choose another slot.', status: 409 },
      }
      const known = knownErrors[sqlMessage]
      if (known) {
        console.warn('[bookings] RPC rejected booking', { category: known.code, code: error.code })
        return errorResponse(known.code, known.message, known.status)
      }
      if (error.code === '23514') {
        console.error('[bookings] database constraint rejected booking', { category: 'database_constraint', code: error.code })
        return errorResponse('BOOKING_DETAILS_REJECTED', 'Please check your booking details and try again.', 400)
      }
      if (error.code === '23505') {
        console.warn('[bookings] booking slot conflict', { category: 'slot_conflict', code: error.code })
        return errorResponse('SLOT_CONFLICT', 'That time was just booked. Choose another slot.', 409)
      }
      console.error('[bookings] RPC invocation failed', { category: 'rpc_failure', code: error.code })
      return errorResponse('BOOKING_FAILED', 'We could not create this booking. Please try again.', 500)
    }

    const booking = Array.isArray(data) ? data[0] : data
    if (!booking || typeof booking.public_token !== 'string' || !booking.public_token) {
      console.error('[bookings] confirmation token missing', { category: 'confirmation_token_missing' })
      return errorResponse('CONFIRMATION_UNAVAILABLE', 'We could not create a confirmation link. Please contact the service owner.', 500)
    }

    return NextResponse.json({ booking, confirmationUrl: `/booking/${booking.public_token}` }, { status: 201 })
  } catch {
    console.error('[bookings] public creation failed', { category: 'unexpected_rpc_failure' })
    return errorResponse('BOOKING_FAILED', 'We could not create this booking. Please try again.', 500)
  }
}
