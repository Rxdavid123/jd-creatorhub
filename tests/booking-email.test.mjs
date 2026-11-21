import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bookingNotificationIdempotencyKey,
  buildBookingEmail,
} from '../lib/booking-email.ts'

const booking = {
  serviceName: 'Portfolio review',
  customerName: 'Jordan Lee',
  customerEmail: 'jordan@example.com',
  customerPhone: '+1 555 010 1234',
  customerNote: 'Please review my latest work.',
  startsAt: '2026-12-01T04:30:00.000Z',
  timezone: 'Asia/Kolkata',
  status: 'confirmed',
}

test('customer booking confirmation includes appointment time, timezone, and status', () => {
  const email = buildBookingEmail('confirmation', booking)

  assert.ok(email)
  assert.equal(email.to, booking.customerEmail)
  assert.match(email.subject, /Booking confirmed/)
  assert.match(email.text, /Portfolio review/)
  assert.match(email.text, /Asia\/Kolkata/)
  assert.match(email.text, /Confirmed/)
  assert.match(email.html, /Portfolio review/)
})

test('creator notification includes customer contact details and a reply-to address', () => {
  const email = buildBookingEmail('new_booking', booking, {
    email: 'creator@example.com',
    name: 'Creator',
  })

  assert.ok(email)
  assert.equal(email.to, 'creator@example.com')
  assert.equal(email.replyTo, booking.customerEmail)
  assert.match(email.text, /Jordan Lee/)
  assert.match(email.text, /\+1 555 010 1234/)
  assert.match(email.text, /Please review my latest work\./)
})

test('creator confirmation and cancellation notifications describe the new state', () => {
  const confirmed = buildBookingEmail('creator_confirmation', booking)
  const cancelled = buildBookingEmail('creator_cancellation', { ...booking, status: 'cancelled' })

  assert.match(confirmed?.text ?? '', /confirmed your appointment/i)
  assert.match(cancelled?.text ?? '', /appointment has been cancelled/i)
  assert.match(cancelled?.text ?? '', /Cancelled/)
})

test('creator notification escapes untrusted customer notes in HTML', () => {
  const email = buildBookingEmail('new_booking', {
    ...booking,
    customerNote: '<script>alert("booking")</script>',
  }, { email: 'creator@example.com' })

  assert.ok(email)
  assert.doesNotMatch(email.html, /<script>/)
  assert.match(email.html, /&lt;script&gt;/)
})

test('change decision emails distinguish approved cancellation, approved reschedule, and rejection', () => {
  const cancellation = buildBookingEmail('change_request_decision', {
    ...booking,
    status: 'cancelled',
    requestType: 'cancellation',
    requestStatus: 'approved',
  })
  const reschedule = buildBookingEmail('change_request_decision', {
    ...booking,
    requestType: 'reschedule',
    requestStatus: 'approved',
    requestedStartsAt: '2026-12-02T04:30:00.000Z',
  })
  const rejected = buildBookingEmail('change_request_decision', {
    ...booking,
    requestType: 'reschedule',
    requestStatus: 'rejected',
  })

  assert.match(cancellation?.subject ?? '', /cancellation approved/i)
  assert.match(cancellation?.text ?? '', /appointment has been cancelled/i)
  assert.match(cancellation?.text ?? '', /Booking status: Cancelled/)
  assert.match(reschedule?.subject ?? '', /reschedule approved/i)
  assert.match(reschedule?.text ?? '', /moved to the requested time/i)
  assert.match(reschedule?.text ?? '', /Requested time:/)
  assert.match(rejected?.text ?? '', /request was declined/i)
  assert.match(rejected?.text ?? '', /existing appointment remains unchanged/i)
})

test('notification retries reuse a stable provider idempotency key', () => {
  const notificationId = 'd05f7715-52ef-43e7-9453-f7f166914d40'

  assert.equal(
    bookingNotificationIdempotencyKey(notificationId),
    bookingNotificationIdempotencyKey(notificationId),
  )
})
