import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { normalizeAvailabilityIntervals, normalizeAvailabilityResponse } from '@/lib/booking-availability'

async function auth() {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  return { client, user }
}

export async function GET(request: Request) {
  const { client, user } = await auth()
  const serviceId = new URL(request.url).searchParams.get('serviceId')
  if (!serviceId) return NextResponse.json({ error: 'serviceId is required.' }, { status: 400 })
  const { data: service } = await client.from('booking_services').select('id,creator_id').eq('id', serviceId).maybeSingle()
  if (!service) return NextResponse.json({ error: 'Service not found.' }, { status: 404 })
  const { data, error } = await client.from('booking_availability').select('id,weekday,start_time,end_time,enabled').eq('service_id', serviceId).order('weekday').order('start_time')
  if (error) return NextResponse.json({ error: 'Unable to load availability.' }, { status: 500 })
  const availability = normalizeAvailabilityResponse(data || [])
  if (!availability) return NextResponse.json({ error: 'Unable to normalize stored availability.' }, { status: 500 })
  return NextResponse.json({ availability })
}

export async function PUT(request: Request) {
  const { client, user } = await auth()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body.serviceId !== 'string' || !Array.isArray(body.availability)) return NextResponse.json({ error: 'Invalid availability settings.' }, { status: 400 })
  const { data: service } = await client.from('booking_services').select('id').eq('id', body.serviceId).eq('creator_id', user.id).maybeSingle()
  if (!service) return NextResponse.json({ error: 'Service not found.' }, { status: 404 })
  const timezone = body.timezone
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }) } catch { return NextResponse.json({ error: 'Choose a valid timezone.' }, { status: 400 }) }
  const rules = ['min_notice_minutes', 'max_advance_days', 'buffer_minutes', 'booking_interval_minutes'] as const
  if (!Number.isInteger(body.min_notice_minutes) || body.min_notice_minutes < 0 || body.min_notice_minutes > 525600
    || !Number.isInteger(body.max_advance_days) || body.max_advance_days < 1 || body.max_advance_days > 730
    || !Number.isInteger(body.buffer_minutes) || body.buffer_minutes < 0 || body.buffer_minutes > 240
    || !Number.isInteger(body.booking_interval_minutes) || body.booking_interval_minutes < 5 || body.booking_interval_minutes > 240) return NextResponse.json({ error: 'Check the booking rule values.' }, { status: 400 })
  const { rows: normalizedRows, error: validationError } = normalizeAvailabilityIntervals(body.availability)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
  const rows = normalizedRows.map((row) => ({ ...row, service_id: service.id }))

  const { error: updateError } = await client.from('booking_services').update({ timezone, min_notice_minutes: body.min_notice_minutes, max_advance_days: body.max_advance_days, buffer_minutes: body.buffer_minutes, booking_interval_minutes: body.booking_interval_minutes }).eq('id', service.id).eq('creator_id', user.id)
  if (updateError) return NextResponse.json({ error: 'Unable to save booking rules. Apply the availability migration first.' }, { status: 503 })
  const { error: deleteError } = await client.from('booking_availability').delete().eq('service_id', service.id)
  if (deleteError) return NextResponse.json({ error: 'Unable to replace the weekly schedule.' }, { status: 500 })
  const { data, error } = rows.length ? await client.from('booking_availability').insert(rows).select('id,weekday,start_time,end_time,enabled').order('weekday').order('start_time') : { data: [], error: null }
  if (error) return NextResponse.json({ error: 'Unable to save weekly schedule.' }, { status: 400 })
  const availability = normalizeAvailabilityResponse(data || [])
  if (!availability) return NextResponse.json({ error: 'Unable to normalize saved availability.' }, { status: 500 })
  return NextResponse.json({ availability })
}
