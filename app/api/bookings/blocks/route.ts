import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { zonedDateTimeToUtc } from '@/lib/bookings'

function validDate(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value }

export async function GET(request: Request) {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const serviceId = new URL(request.url).searchParams.get('serviceId')
  if (!serviceId) return NextResponse.json({ error: 'serviceId is required.' }, { status: 400 })
  const { data: service } = await client.from('booking_services').select('id').eq('id', serviceId).eq('creator_id', user.id).maybeSingle()
  if (!service) return NextResponse.json({ error: 'Service not found.' }, { status: 404 })
  const [dates, times] = await Promise.all([
    client.from('booking_blocked_dates').select('id,blocked_date,reason').eq('service_id', serviceId).order('blocked_date'),
    client.from('booking_time_blocks').select('id,starts_at,ends_at,reason').eq('service_id', serviceId).order('starts_at'),
  ])
  if (dates.error || times.error) return NextResponse.json({ error: 'Unable to load unavailable periods.' }, { status: 500 })
  return NextResponse.json({ blocks: [...(dates.data || []), ...(times.data || [])] })
}

export async function POST(request: Request) {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  const { serviceId, blockedDate, startsAt, endsAt, timezone, reason } = body as Record<string, unknown>
  if (typeof serviceId !== 'string') return NextResponse.json({ error: 'serviceId is required.' }, { status: 400 })
  const { data: service } = await client.from('booking_services').select('id,timezone').eq('id', serviceId).eq('creator_id', user.id).maybeSingle()
  if (!service) return NextResponse.json({ error: 'Service not found.' }, { status: 404 })
  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 200) || null : null
  if (blockedDate !== undefined) {
    if (!validDate(blockedDate)) return NextResponse.json({ error: 'Choose a valid calendar date.' }, { status: 400 })
    const { data, error } = await client.from('booking_blocked_dates').upsert({ service_id: serviceId, blocked_date: blockedDate, reason: safeReason }, { onConflict: 'service_id,blocked_date' }).select('id,blocked_date,reason').single()
    return error ? NextResponse.json({ error: 'Unable to block this date.' }, { status: 400 }) : NextResponse.json({ block: data }, { status: 201 })
  }
  if (typeof startsAt !== 'string' || typeof endsAt !== 'string' || typeof timezone !== 'string' || !/^\d{2}:\d{2}$/.test(startsAt.slice(11, 16)) || !/^\d{2}:\d{2}$/.test(endsAt.slice(11, 16)) || startsAt.slice(0,10) !== endsAt.slice(0,10) || !validDate(startsAt.slice(0,10))) return NextResponse.json({ error: 'Choose a valid date and time range.' }, { status: 400 })
  if (timezone !== service.timezone) return NextResponse.json({ error: 'Refresh and use the service timezone.' }, { status: 400 })
  const start = zonedDateTimeToUtc(startsAt.slice(0,10), startsAt.slice(11,16), timezone)
  const end = zonedDateTimeToUtc(endsAt.slice(0,10), endsAt.slice(11,16), timezone)
  if (end <= start) return NextResponse.json({ error: 'End time must be after start time.' }, { status: 400 })
  const { data, error } = await client.from('booking_time_blocks').insert({ service_id: serviceId, starts_at: start.toISOString(), ends_at: end.toISOString(), reason: safeReason }).select('id,starts_at,ends_at,reason').single()
  return error ? NextResponse.json({ error: 'Unable to block this time.' }, { status: 400 }) : NextResponse.json({ block: data }, { status: 201 })
}

export async function DELETE(request: Request) {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body.serviceId !== 'string' || typeof body.id !== 'string' || !['date','time'].includes(body.kind)) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  const { data: service } = await client.from('booking_services').select('id').eq('id', body.serviceId).eq('creator_id', user.id).maybeSingle()
  if (!service) return NextResponse.json({ error: 'Service not found.' }, { status: 404 })
  const table = body.kind === 'date' ? 'booking_blocked_dates' : 'booking_time_blocks'
  const { error } = await client.from(table).delete().eq('id', body.id).eq('service_id', body.serviceId)
  return error ? NextResponse.json({ error: 'Unable to remove unavailable period.' }, { status: 400 }) : NextResponse.json({ ok: true })
}
