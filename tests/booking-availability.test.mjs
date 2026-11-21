import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { isoDate, zonedDateTimeToUtc } from '../lib/bookings.ts'
import { normalizeAvailabilityIntervals, normalizeAvailabilityResponse, normalizeTime } from '../lib/booking-availability.ts'

const migration = fs.readFileSync('supabase/migrations/20261121100000_creator_booking_availability.sql', 'utf8')
const settings = fs.readFileSync('components/booking/availability-settings.tsx', 'utf8')
const slots = fs.readFileSync('app/api/bookings/slots/route.ts', 'utf8')
const api = fs.readFileSync('app/api/bookings/availability/route.ts', 'utf8')
const blockApi = fs.readFileSync('app/api/bookings/blocks/route.ts', 'utf8')

function procedure(name, signature) {
  const start = migration.indexOf(`create or replace function public.${name}(`)
  assert.notEqual(start, -1, `${name} procedure exists`)
  const end = migration.indexOf(`revoke all on function public.${name}(${signature})`, start)
  assert.notEqual(end, -1, `${name} keeps its expected RPC signature`)
  return migration.slice(start, end)
}

const createBooking = procedure('create_public_booking', 'uuid,timestamptz,text,text,text,text')
const submitChange = procedure('submit_booking_change_request', 'text,text,text,timestamptz')
const decideChange = procedure('decide_booking_change_request', 'uuid,uuid,text')
const procedures = [createBooking, submitChange, decideChange]

test('supports multiple weekly windows without replacing the existing availability table', () => {
  assert.match(migration, /drop constraint if exists booking_availability_service_id_weekday_key/)
  assert.match(slots, /\.order\('start_time'\)/)
  assert.match(settings, /Add interval/)
  assert.match(fs.readFileSync('lib/booking-availability.ts', 'utf8'), /Working intervals on the same day cannot overlap/)
})

test('booking rules, blocked dates and time ranges are checked by server routes', () => {
  assert.match(migration, /booking_interval_minutes integer not null/)
  assert.match(createBooking, /a\.start_time <= local_start::time and a\.end_time >= local_end::time/)
  assert.match(createBooking, /pg_advisory_xact_lock/)
  assert.match(slots, /booking_time_blocks/)
  assert.match(slots, /booking_change_requests/)
  assert.match(slots, /min_notice_minutes/)
  assert.match(blockApi, /eq\('creator_id', user\.id\)/)
  assert.match(blockApi, /zonedDateTimeToUtc/)
})

test('all booking paths allow multiple intervals and align slots to each interval start', () => {
  for (const source of procedures) {
    assert.match(source, /exists\s*\(\s*select 1 from public\.booking_availability a/)
    assert.match(source, /a\.start_time <= local_start::time and a\.end_time >= local_end::time/)
    assert.match(source, /local_start::time - a\.start_time/)
    assert.match(source, /s\.booking_interval_minutes/)
  }
})

test('customer rescheduling rejects starts outside configured slot intervals', () => {
  assert.match(submitChange, /if not exists \([\s\S]*local_start::time - a\.start_time[\s\S]*\) then raise exception 'outside_availability'/)
  assert.match(decideChange, /if not exists \([\s\S]*local_start::time - a\.start_time[\s\S]*\) then raise exception 'outside_availability'/)
})

test('rescheduling checks appointment duration and buffer on both sides', () => {
  for (const source of [submitChange, decideChange]) {
    assert.match(source, /x\.starts_at < [\s\S]*make_interval\(mins => s\.duration_minutes \+ s\.buffer_minutes\)/)
    assert.match(source, /x\.ends_at \+ make_interval\(mins => s\.buffer_minutes\) >/)
    assert.match(source, /requested_starts_at \+ make_interval\(mins => s\.duration_minutes \+ s\.buffer_minutes\)/)
  }
})

test('new bookings reserve pending rescheduling slots and reject buffered overlap', () => {
  assert.match(createBooking, /public\.booking_change_requests r[\s\S]*r\.status = 'pending'[\s\S]*r\.request_type = 'reschedule'/)
  assert.match(createBooking, /r\.requested_starts_at \+ make_interval\(mins => s\.duration_minutes \+ s\.buffer_minutes\)/)
  assert.match(createBooking, /x\.ends_at \+ make_interval\(mins => s\.buffer_minutes\) > p_starts_at/)
})

test('all three write paths share one service-scoped transaction lock against concurrent overlaps', () => {
  for (const source of procedures) {
    assert.equal((source.match(/pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(s\.id::text, 0\)\)/g) || []).length, 1)
  }
})

test('creator approval excludes only its own request from pending-request conflicts', () => {
  assert.match(decideChange, /other_request\.id <> r\.id/)
  assert.match(decideChange, /x\.id <> b\.id/)
  assert.match(decideChange, /x\.status in \('pending','confirmed'\)/)
  assert.match(decideChange, /other_request\.status = 'pending'/)
})

test('all procedures preserve definer security and hardened search paths', () => {
  for (const source of procedures) {
    assert.match(source, /security definer\s+set search_path = ''/)
  }
  assert.match(migration, /grant execute on function public\.submit_booking_change_request\(text,text,text,timestamptz\) to service_role/)
  assert.match(migration, /grant execute on function public\.decide_booking_change_request\(uuid,uuid,text\) to service_role/)
  assert.match(migration, /revoke all on function public\.submit_booking_change_request\(text,text,text,timestamptz\) from public, anon, authenticated/)
  assert.match(migration, /revoke all on function public\.decide_booking_change_request\(uuid,uuid,text\) from public, anon, authenticated/)
})

test('blocked dates and blocked times are enforced for bookings and reschedules', () => {
  for (const source of procedures) {
    assert.match(source, /public\.booking_blocked_dates[\s\S]*blocked_date = local_start::date/)
    assert.match(source, /public\.booking_time_blocks[\s\S]*starts_at < [\s\S]*ends_at >/)
  }
})

test('PostgreSQL time values and UI time values normalize to HH:MM for saving', () => {
  const { rows, error } = normalizeAvailabilityIntervals([
    { weekday: 1, start_time: '09:00:00', end_time: '17:00:00', enabled: true },
    { weekday: 2, start_time: '09:00', end_time: '17:00', enabled: true },
  ])
  assert.equal(error, null)
  assert.deepEqual(rows.map(({ start_time, end_time }) => [start_time, end_time]), [['09:00', '17:00'], ['09:00', '17:00']])
  assert.equal(normalizeTime('09:00:00.123456'), '09:00')
})

test('invalid hours, minutes, seconds, and malformed times are rejected', () => {
  for (const value of ['25:00', '09:75', '09:00:60', '9:00', '09:0', '09:00:00x', '']) {
    assert.equal(normalizeTime(value), null, `${value} must be invalid`)
    const { error } = normalizeAvailabilityIntervals([{ weekday: 1, start_time: value, end_time: '17:00', enabled: true }])
    assert.match(error || '', /valid weekday and end after its start/)
  }
})

test('start time must precede end time after normalization', () => {
  const { error } = normalizeAvailabilityIntervals([{ weekday: 1, start_time: '17:00:00', end_time: '09:00:00', enabled: true }])
  assert.match(error || '', /end after its start/)
})

test('overlapping weekday intervals are rejected and multiple disjoint intervals are accepted', () => {
  const overlapping = normalizeAvailabilityIntervals([
    { weekday: 1, start_time: '09:00:00', end_time: '12:00:00', enabled: true },
    { weekday: 1, start_time: '11:59', end_time: '17:00', enabled: true },
  ])
  assert.match(overlapping.error || '', /cannot overlap/)

  const separate = normalizeAvailabilityIntervals([
    { weekday: 1, start_time: '09:00:00', end_time: '12:00:00', enabled: true },
    { weekday: 1, start_time: '13:00', end_time: '17:00:00', enabled: true },
  ])
  assert.equal(separate.error, null)
  assert.equal(separate.rows.length, 2)
})

test('GET and PUT response rows are always normalized to HH:MM', () => {
  const rows = normalizeAvailabilityResponse([
    { id: 'a', weekday: 1, start_time: '09:00:00', end_time: '17:00:00.000000', enabled: true },
  ])
  assert.deepEqual(rows?.map(({ start_time, end_time }) => [start_time, end_time]), [['09:00', '17:00']])
  assert.equal(normalizeAvailabilityResponse([{ start_time: 'bad', end_time: '17:00' }]), null)
  assert.equal((api.match(/normalizeAvailabilityResponse\(data \|\| \[\]\)/g) || []).length, 2)
})

test('timezone conversion keeps local calendar boundaries explicit', () => {
  const latePacific = zonedDateTimeToUtc('2026-01-01', '00:30', 'America/Los_Angeles')
  assert.equal(latePacific.toISOString(), '2026-01-01T08:30:00.000Z')
  assert.equal(isoDate(latePacific.toISOString(), 'America/Los_Angeles'), '2026-01-01')
  const nextUtcDate = zonedDateTimeToUtc('2026-01-01', '00:15', 'Asia/Kolkata')
  assert.equal(nextUtcDate.toISOString(), '2025-12-31T18:45:00.000Z')
  assert.equal(isoDate(nextUtcDate.toISOString(), 'Asia/Kolkata'), '2026-01-01')
})
