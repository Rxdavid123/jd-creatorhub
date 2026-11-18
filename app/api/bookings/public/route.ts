import { after, NextResponse } from 'next/server'
import { deliverBookingNotificationsForBooking } from '@/lib/booking-email-delivery'
import { zonedDateTimeToUtc, bookingEmailPattern } from '@/lib/bookings'
import {
  buildPublicBookingConfirmation,
  getSafeBookingFailure,
  resolvePublicBookingRpcError,
} from '@/lib/public-booking-errors'
import { createClient } from '@/lib/supabase/server'

function errorResponse(code: string, error: string, status: number) {
  return NextResponse.json({ code, error }, { status })
}

function logDatabaseFailure(stage: string, error: unknown, serviceId: string, sensitiveValues: string[] = []) {
  const safeFailure = getSafeBookingFailure(error, sensitiveValues)
  console.error('[bookings] Supabase operation failed', {
    stage,
    category: 'database_failure',
    code: safeFailure.code,
    message: safeFailure.message,
    serviceId,
  })
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

  const phone = typeof body.customerPhone === 'string' ? body.customerPhone.trim() : ''
  const note = typeof body.customerNote === 'string' ? body.customerNote.trim() : ''
  const sensitiveValues = [customerName, customerEmail, phone, note]

  let client: Awaited<ReturnType<typeof createClient>>
  try {
    client = await createClient()
  } catch (error) {
    logDatabaseFailure('create_client', error, serviceId, sensitiveValues)
    return errorResponse('BOOKING_TEMPORARILY_UNAVAILABLE', 'We could not verify this service right now. Please refresh and try again.', 503)
  }

  let service: { id: string; timezone: string } | null = null
  let serviceError: { code?: string | null; message?: string | null } | null = null
  try {
    const lookup = await client.from('booking_services')
      .select('id,timezone').eq('id', serviceId).eq('status', 'published').maybeSingle()
    service = lookup.data
    serviceError = lookup.error
  } catch (error) {
    logDatabaseFailure('service_lookup', error, serviceId, sensitiveValues)
    return errorResponse('SERVICE_LOOKUP_FAILED', 'We could not verify this service right now. Please refresh and try again.', 503)
  }

  if (serviceError) {
    logDatabaseFailure('service_lookup', serviceError, serviceId, sensitiveValues)
    return errorResponse('SERVICE_LOOKUP_FAILED', 'We could not verify this service right now. Please refresh and try again.', 503)
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
      const failure = resolvePublicBookingRpcError(error)
      const context = {
        stage: 'create_public_booking',
        category: failure.code,
        code: error.code,
        message: getSafeBookingFailure(error, sensitiveValues).message,
        serviceId,
      }
      if (failure.status >= 500) {
        console.error('[bookings] Supabase RPC failed', context)
      } else {
        console.warn('[bookings] Supabase RPC rejected booking', context)
      }
      return errorResponse(failure.code, failure.message, failure.status)
    }

    const confirmation = buildPublicBookingConfirmation(data)
    if (!confirmation) {
      console.error('[bookings] confirmation token missing', {
        stage: 'create_public_booking',
        category: 'confirmation_token_missing',
        serviceId,
      })
      return errorResponse('CONFIRMATION_UNAVAILABLE', 'We could not create a confirmation link. Please contact the service owner.', 500)
    }

    const bookingId = typeof confirmation.booking.id === 'string' ? confirmation.booking.id : null
    if (bookingId) {
      try {
        after(async () => {
          try {
            await deliverBookingNotificationsForBooking(bookingId, ['confirmation', 'new_booking'])
          } catch {
            console.error('[booking-email] post-booking dispatch failed', { bookingId })
          }
        })
      } catch {
        console.error('[booking-email] post-booking callback could not be scheduled', { bookingId })
      }
    }

    return NextResponse.json(confirmation, { status: 201 })
  } catch (error) {
    logDatabaseFailure('create_public_booking', error, serviceId, sensitiveValues)
    return errorResponse('BOOKING_TEMPORARILY_UNAVAILABLE', "We couldn't complete this booking right now. Please try again shortly or contact the service owner.", 503)
  }
}
