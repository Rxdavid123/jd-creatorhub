import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

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
  return NextResponse.json({ availability: data || [] })
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
  const availabilityInput = body.availability as Record<string, unknown>[]
  const rows: { service_id: string; weekday: number; start_time: string; end_time: string; enabled: boolean }[] = availabilityInput.map((row) => ({
    service_id: service.id,
    weekday: Number(row.weekday),
    start_time: typeof row.start_time === 'string' ? row.start_time : '',
    end_time: typeof row.end_time === 'string' ? row.end_time : '',
    enabled: row.enabled === true,
  }))
  if (rows.length > 70 || rows.some((row) => !Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6 || typeof row.start_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.start_time) || typeof row.end_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.end_time) || row.start_time >= row.end_time)) return NextResponse.json({ error: 'Each interval must have a valid weekday and end after its start.' }, { status: 400 })
  for (let weekday = 0; weekday < 7; weekday++) {
    const dayRows = rows.filter((row) => row.weekday === weekday && row.enabled).sort((a, b) => a.start_time.localeCompare(b.start_time))
    if (dayRows.some((row, index) => index > 0 && dayRows[index - 1].end_time > row.start_time)) return NextResponse.json({ error: 'Working intervals on the same day cannot overlap.' }, { status: 400 })
  }
  const { error: updateError } = await client.from('booking_services').update({ timezone, min_notice_minutes: body.min_notice_minutes, max_advance_days: body.max_advance_days, buffer_minutes: body.buffer_minutes, booking_interval_minutes: body.booking_interval_minutes }).eq('id', service.id).eq('creator_id', user.id)
  if (updateError) return NextResponse.json({ error: 'Unable to save booking rules. Apply the availability migration first.' }, { status: 503 })
  const { error: deleteError } = await client.from('booking_availability').delete().eq('service_id', service.id)
  if (deleteError) return NextResponse.json({ error: 'Unable to replace the weekly schedule.' }, { status: 500 })
  const { data, error } = rows.length ? await client.from('booking_availability').insert(rows).select('id,weekday,start_time,end_time,enabled').order('weekday').order('start_time') : { data: [], error: null }
  return error ? NextResponse.json({ error: 'Unable to save weekly schedule.' }, { status: 400 }) : NextResponse.json({ availability: data || [] })
}
