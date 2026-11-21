import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const migration = fs.readFileSync('supabase/migrations/20261120120000_customer_booking_requests.sql', 'utf8')
const route = fs.readFileSync('app/api/bookings/customer/[token]/route.ts', 'utf8')
const dashboard = fs.readFileSync('app/dashboard/bookings/page.tsx', 'utf8')
const delivery = fs.readFileSync('lib/booking-email-delivery.ts', 'utf8')

test('request table keeps one pending request per booking and scopes creator reads', () => {
  assert.match(migration, /booking_change_requests_one_pending_idx[\s\S]*?where status = 'pending'/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /booking_change_requests_creator_read[\s\S]*?auth\.uid\(\)/)
  assert.match(migration, /revoke all on public\.booking_change_requests from anon, authenticated/)
})

test('customer submission is authorized only by the opaque booking token', () => {
  assert.match(route, /\^\[a-f0-9\]\{48\}\$/i)
  assert.match(route, /submit_booking_change_request/)
  assert.match(migration, /public_token = p_token/)
  assert.match(route, /type === 'reschedule' && !requestedAt/)
})

test('reschedule is validated again atomically at creator approval', () => {
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /booking_availability/)
  assert.match(migration, /booking_blocked_dates/)
  assert.match(migration, /booking_time_blocks/)
  assert.match(migration, /x\.starts_at < r\.requested_starts_at[\s\S]*?x\.ends_at > r\.requested_starts_at/)
  assert.match(migration, /where id = b\.id/)
})

test('creator decisions verify ownership and pending state in the database transaction', () => {
  assert.match(migration, /b\.creator_id <> p_creator_id/)
  assert.match(migration, /r\.status <> 'pending'/)
  assert.match(route, /auth\.getUser\(\)/)
  assert.match(route, /p_creator_id: user\.id/)
  assert.match(dashboard, /decideRequest\(request\.id, 'approved'\)/)
  assert.match(dashboard, /decideRequest\(request\.id, 'rejected'\)/)
})

test('request emails are queued through the existing notification delivery flow', () => {
  assert.match(migration, /change_request_submitted/)
  assert.match(migration, /change_request_decision/)
  assert.match(delivery, /change_request_submitted/)
  assert.match(delivery, /booking_change_requests/)
  assert.match(route, /deliverBookingNotificationsForBooking/)
})
