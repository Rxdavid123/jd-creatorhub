import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { isoDate, zonedDateTimeToUtc } from '../lib/bookings.ts'

const migration = fs.readFileSync('supabase/migrations/20261121100000_creator_booking_availability.sql', 'utf8')
const settings = fs.readFileSync('components/booking/availability-settings.tsx', 'utf8')
const slots = fs.readFileSync('app/api/bookings/slots/route.ts', 'utf8')
const api = fs.readFileSync('app/api/bookings/availability/route.ts', 'utf8')
const blockApi = fs.readFileSync('app/api/bookings/blocks/route.ts', 'utf8')

test('supports multiple weekly windows without replacing the existing availability table', () => {
  assert.match(migration, /drop constraint if exists booking_availability_service_id_weekday_key/)
  assert.match(slots, /\.order\('start_time'\)/)
  assert.match(settings, /Add interval/)
  assert.match(api, /Working intervals on the same day cannot overlap/)
})

test('booking rules, blocked dates and time ranges are checked by server routes', () => {
  assert.match(migration, /booking_interval_minutes integer not null/)
  assert.match(migration, /a\.start_time <= local_start::time and a\.end_time >= local_end::time/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(slots, /booking_time_blocks/)
  assert.match(slots, /booking_change_requests/)
  assert.match(slots, /min_notice_minutes/)
  assert.match(blockApi, /eq\('creator_id', user\.id\)/)
  assert.match(blockApi, /zonedDateTimeToUtc/)
})

test('timezone conversion keeps local calendar boundaries explicit', () => {
  const latePacific = zonedDateTimeToUtc('2026-01-01', '00:30', 'America/Los_Angeles')
  assert.equal(latePacific.toISOString(), '2026-01-01T08:30:00.000Z')
  assert.equal(isoDate(latePacific.toISOString(), 'America/Los_Angeles'), '2026-01-01')
  const nextUtcDate = zonedDateTimeToUtc('2026-01-01', '00:15', 'Asia/Kolkata')
  assert.equal(nextUtcDate.toISOString(), '2025-12-31T18:45:00.000Z')
  assert.equal(isoDate(nextUtcDate.toISOString(), 'Asia/Kolkata'), '2026-01-01')
})
