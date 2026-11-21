import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isoDate, slotLabel, zonedDateTimeToUtc } from '@/lib/bookings'

function serviceRoleClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Booking availability server configuration is missing.')
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const requestedServiceId = url.searchParams.get('serviceId')
  const token = url.searchParams.get('token')
  const date = url.searchParams.get('date')
  if ((!requestedServiceId && !token) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || (token && !/^[a-f0-9]{48}$/i.test(token))) return NextResponse.json({ error: 'A valid service and date are required.' }, { status: 400 })
  const client = await createClient()
  const admin = serviceRoleClient()
  let serviceId = requestedServiceId
  if (token) {
    const { data: booking } = await admin.from('bookings').select('service_id').eq('public_token', token).maybeSingle()
    if (!booking) return NextResponse.json({ error: 'Booking not found.' }, { status: 404 })
    serviceId = booking.service_id
  }
  const { data: service, error: serviceError } = await client.from('booking_services').select('id,duration_minutes,buffer_minutes,min_notice_minutes,max_advance_days,timezone,status').eq('id', serviceId).eq('status', 'published').maybeSingle()
  if (serviceError) return NextResponse.json({ error: 'Unable to load service availability.' }, { status: 500 })
  if (!service) return NextResponse.json({ error: 'Service not found.' }, { status: 404 })
  const today = isoDate(new Date().toISOString(), service.timezone)
  const latest = new Date(Date.now() + service.max_advance_days * 86400000)
  if (date < today || date > isoDate(latest.toISOString(), service.timezone)) return NextResponse.json({ slots: [], timezone: service.timezone, reason: 'outside_booking_window' })
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  const [{ data: intervals, error: intervalsError }, { data: blockedDate, error: dateError }] = await Promise.all([
    client.from('booking_availability').select('start_time,end_time').eq('service_id', service.id).eq('weekday', weekday).eq('enabled', true).order('start_time'),
    client.from('booking_blocked_dates').select('id').eq('service_id', service.id).eq('blocked_date', date).maybeSingle(),
  ])
  if (intervalsError || dateError) return NextResponse.json({ error: 'Unable to load availability.' }, { status: 500 })
  if (blockedDate) return NextResponse.json({ slots: [], timezone: service.timezone, reason: 'blocked_date' })
  if (!intervals?.length) return NextResponse.json({ slots: [], timezone: service.timezone, reason: 'no_schedule' })
  const dayStart = zonedDateTimeToUtc(date, '00:00', service.timezone)
  const nextDate = new Date(`${date}T12:00:00Z`); nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  const dayEnd = zonedDateTimeToUtc(isoDate(nextDate.toISOString(), 'UTC'), '00:00', service.timezone)
  const [bookingsResult, blocksResult, requestsResult] = await Promise.all([
    admin.from('bookings').select('starts_at,ends_at').eq('service_id', service.id).in('status', ['pending','confirmed']).lt('starts_at', dayEnd.toISOString()).gt('ends_at', dayStart.toISOString()),
    admin.from('booking_time_blocks').select('starts_at,ends_at').eq('service_id', service.id).lt('starts_at', dayEnd.toISOString()).gt('ends_at', dayStart.toISOString()),
    admin.from('booking_change_requests').select('requested_starts_at,bookings!inner(service_id)').eq('status', 'pending').not('requested_starts_at', 'is', null).gte('requested_starts_at', dayStart.toISOString()).lt('requested_starts_at', dayEnd.toISOString()),
  ])
  if (bookingsResult.error || blocksResult.error || requestsResult.error) return NextResponse.json({ error: 'Unable to verify currently occupied times.' }, { status: 500 })
  const occupied = [
    ...(bookingsResult.data || []).map((item) => ({ start: Date.parse(item.starts_at), end: Date.parse(item.ends_at) + service.buffer_minutes * 60000 })),
    ...(blocksResult.data || []).map((item) => ({ start: Date.parse(item.starts_at), end: Date.parse(item.ends_at) })),
    ...(requestsResult.data || []).filter((item: any) => item.bookings?.service_id === service.id).map((item) => { const start = Date.parse(item.requested_starts_at); return { start, end: start + (service.duration_minutes + service.buffer_minutes) * 60000 } }),
  ]
  const intervalMinutes = Math.max(5, Number((service as typeof service & { booking_interval_minutes?: number }).booking_interval_minutes) || Number(service.duration_minutes))
  const slots: { startsAt: string; label: string }[] = []
  for (const interval of intervals) {
    const start = interval.start_time.slice(0, 5)
    const end = interval.end_time.slice(0, 5)
    let cursor = zonedDateTimeToUtc(date, start, service.timezone)
    const endUtc = zonedDateTimeToUtc(date, end, service.timezone)
    while (cursor.getTime() + service.duration_minutes * 60000 <= endUtc.getTime()) {
      const startMs = cursor.getTime()
      const endMs = startMs + service.duration_minutes * 60000
      const startsAt = cursor.toISOString()
      const conflicts = occupied.some((item) => item.start < endMs + service.buffer_minutes * 60000 && item.end > startMs)
      if (startMs >= Date.now() + service.min_notice_minutes * 60000 && !conflicts) slots.push({ startsAt, label: slotLabel(startsAt, service.timezone) })
      cursor = new Date(startMs + intervalMinutes * 60000)
    }
  }
  return NextResponse.json({ slots, timezone: service.timezone })
}
