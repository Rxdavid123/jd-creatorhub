import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bookingEmailPattern } from '../lib/bookings.ts'
import {
  buildPublicBookingConfirmation,
  getSafeBookingFailure,
  redactPublicBookingDiagnostic,
  resolvePublicBookingRpcError,
} from '../lib/public-booking-errors.ts'

describe('public booking submission outcomes', () => {
  it('builds a confirmation response from a successful RPC result', () => {
    const booking = { id: 'booking-id', public_token: 'a'.repeat(48) }
    assert.deepEqual(buildPublicBookingConfirmation(booking), {
      booking,
      confirmationUrl: `/booking/${booking.public_token}`,
    })
    assert.deepEqual(buildPublicBookingConfirmation([booking]), {
      booking,
      confirmationUrl: `/booking/${booking.public_token}`,
    })
  })

  it('rejects invalid email before attempting a booking', () => {
    assert.equal(bookingEmailPattern.test('not-an-email'), false)
    assert.deepEqual(resolvePublicBookingRpcError({ code: 'P0001', message: 'invalid_customer' }), {
      code: 'INVALID_CUSTOMER',
      message: 'Please check your name and email address.',
      status: 400,
    })
  })

  it('returns an actionable response for unavailable slots', () => {
    assert.deepEqual(resolvePublicBookingRpcError({ code: 'P0001', message: 'outside_availability' }), {
      code: 'OUTSIDE_AVAILABILITY',
      message: 'That time is outside working hours.',
      status: 400,
    })
  })

  it('returns an actionable response for expired booking windows', () => {
    assert.deepEqual(resolvePublicBookingRpcError({ code: 'P0001', message: 'outside_booking_window' }), {
      code: 'OUTSIDE_BOOKING_WINDOW',
      message: 'Choose a time within the booking window.',
      status: 400,
    })
  })

  it('maps duplicate slot submissions to a conflict', () => {
    assert.deepEqual(resolvePublicBookingRpcError({ code: 'P0001', message: 'slot_taken' }), {
      code: 'SLOT_CONFLICT',
      message: 'That time was just booked. Choose another slot.',
      status: 409,
    })
    assert.equal(resolvePublicBookingRpcError({ code: '23505', message: 'duplicate key' }).status, 409)
  })

  it('keeps database failures safe for the visitor and diagnostic details private', () => {
    const internal = 'permission denied for relation bookings'
    const failure = resolvePublicBookingRpcError({ code: '42501', message: internal })
    const diagnostic = getSafeBookingFailure(
      { code: '42501', message: `${internal}: jane@example.com +1 (415) 555-0199` },
      ['Jane Doe'],
    )

    assert.equal(failure.status, 503)
    assert.equal(failure.message.includes(internal), false)
    assert.equal(diagnostic.code, '42501')
    assert.match(diagnostic.message, /permission denied for relation bookings/)
    assert.doesNotMatch(diagnostic.message, /jane@example\.com|415|Jane Doe/i)
  })

  it('redacts customer-provided values and common personal identifiers', () => {
    assert.equal(
      redactPublicBookingDiagnostic('Constraint error for Sam at sam@example.com, 555-123-4567', ['Sam']),
      'Constraint error for [redacted] at [redacted-email], [redacted-number]',
    )
  })

  it('does not treat a malformed RPC result as a successful booking', () => {
    assert.equal(buildPublicBookingConfirmation(null), null)
    assert.equal(buildPublicBookingConfirmation({ id: 'booking-id' }), null)
  })
})
