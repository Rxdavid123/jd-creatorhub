import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import fs from 'node:fs'
import { formatMinorAmount, isBookingCurrency, parseMajorAmount } from '../lib/booking-currency.ts'
import { getRazorpayTestConfigurationErrorCode, isRazorpayTestKey, matchesCapturedRazorpayPayment, verifyRazorpayCheckoutSignature } from '../lib/razorpay-booking-security.ts'

const orderId = 'order_testOrder123'
const paymentId = 'pay_testPayment456'
const secret = 'test-secret-for-unit-tests-only'
const signature = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex')
const captured = { id: paymentId, order_id: orderId, status: 'captured', amount: 10000, currency: 'INR' }

test('paid appointment amounts are exact integer minor units', () => {
  assert.equal(parseMajorAmount('100', 'INR'), 10000)
  assert.equal(parseMajorAmount('100.05', 'INR'), 10005)
  assert.equal(parseMajorAmount('0', 'USD'), 0)
  assert.equal(formatMinorAmount(10000, 'INR'), '₹100.00')
})

test('unsupported currencies and imprecise amounts are rejected', () => {
  assert.equal(isBookingCurrency('INR'), true)
  assert.equal(isBookingCurrency('JPY'), false)
  assert.equal(parseMajorAmount('100.001', 'INR'), null)
  assert.equal(parseMajorAmount('-1', 'INR'), null)
  assert.equal(parseMajorAmount('1e2', 'INR'), null)
  assert.equal(parseMajorAmount('100', 'XXX'), null)
})

test('only Test Mode Razorpay keys are accepted for booking checkout', () => {
  assert.equal(isRazorpayTestKey('rzp_test_abc123'), true)
  assert.equal(isRazorpayTestKey('rzp_live_abc123'), false)
  assert.equal(isRazorpayTestKey(undefined), false)
})

test('Razorpay configuration checks classify missing credentials and reject Live Mode safely', () => {
  assert.equal(getRazorpayTestConfigurationErrorCode(undefined, undefined), 'RAZORPAY_TEST_KEY_ID_MISSING')
  assert.equal(getRazorpayTestConfigurationErrorCode('rzp_live_secretlike', 'never-log-this-secret'), 'RAZORPAY_KEY_ID_NOT_TEST_MODE')
  assert.equal(getRazorpayTestConfigurationErrorCode('rzp_test_valid123', '   '), 'RAZORPAY_TEST_KEY_SECRET_MISSING')
  assert.equal(getRazorpayTestConfigurationErrorCode('rzp_test_valid123', 'test-secret'), null)
  assert.doesNotMatch(JSON.stringify({ code: getRazorpayTestConfigurationErrorCode('rzp_test_valid123', '') }), /test-secret|valid123/)
})

test('checkout returns a safe actionable configuration code without secret material', () => {
  const route = fs.readFileSync('app/api/bookings/payments/checkout/route.ts', 'utf8')
  assert.match(route, /code: error\.code/)
  assert.match(route, /console\.error\('\[booking-payment\] Razorpay configuration check failed', \{ code: error\.code \}\)/)
  assert.doesNotMatch(route, /keySecret|Buffer\.from/)
})

test('checkout signature rejects forged, incomplete, and mismatched identifiers', () => {
  assert.equal(verifyRazorpayCheckoutSignature(orderId, paymentId, signature, secret), true)
  assert.equal(verifyRazorpayCheckoutSignature(orderId, paymentId, `${signature.slice(0, -1)}0`, secret), false)
  assert.equal(verifyRazorpayCheckoutSignature('order_other', paymentId, signature, secret), false)
  assert.equal(verifyRazorpayCheckoutSignature(orderId, 'pay_other', signature, secret), false)
  assert.equal(verifyRazorpayCheckoutSignature(orderId, paymentId, 'bad', secret), false)
})

test('server-fetched captured payment must match order, payment, amount, and currency', () => {
  const expected = { paymentId, orderId, amountMinor: 10000, currency: 'INR' }
  assert.equal(matchesCapturedRazorpayPayment(captured, expected), true)
  assert.equal(matchesCapturedRazorpayPayment({ ...captured, order_id: 'order_wrong' }, expected), false)
  assert.equal(matchesCapturedRazorpayPayment({ ...captured, id: 'pay_wrong' }, expected), false)
  assert.equal(matchesCapturedRazorpayPayment({ ...captured, amount: 9999 }, expected), false)
  assert.equal(matchesCapturedRazorpayPayment({ ...captured, currency: 'USD' }, expected), false)
  assert.equal(matchesCapturedRazorpayPayment({ ...captured, status: 'authorized' }, expected), false)
})

test('booking payment migration isolates appointment money and expires pending holds', () => {
  const sql = fs.readFileSync('supabase/migrations/20261125120000_paid_appointment_bookings.sql', 'utf8')
  assert.match(sql, /create table if not exists public\.booking_payments/)
  assert.match(sql, /references public\.bookings\(id\)/)
  assert.match(sql, /booking_payments_creator_read/)
  assert.match(sql, /revoke all on public\.booking_payments from public, anon, authenticated/)
  assert.match(sql, /unique \(provider, provider_order_id\)/)
  assert.match(sql, /unique \(provider, provider_payment_id\)/)
  assert.match(sql, /payment_expires_at/)
  assert.match(sql, /status = 'expired'/)
  assert.match(sql, /pg_advisory_xact_lock/)
  assert.match(sql, /create or replace function public\.confirm_booking_payment/)
  assert.match(sql, /on conflict \(booking_id, notification_type\) do nothing/)
})

test('payment mutation functions are service-role-only and creator reads are owner-scoped', () => {
  const sql = fs.readFileSync('supabase/migrations/20261125120000_paid_appointment_bookings.sql', 'utf8')
  assert.match(sql, /grant select on public\.booking_payments to authenticated/)
  assert.match(sql, /and b\.creator_id = \(select auth\.uid\(\)\)/)
  assert.match(sql, /revoke all on function public\.prepare_booking_payment_attempt\(text\) from public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.prepare_booking_payment_attempt\(text\) to service_role/)
  assert.match(sql, /not \(price_minor > 0 and payment_status <> 'captured' and status = 'confirmed'\)/)
  assert.match(sql, /grant update \(status, cancelled_at, internal_note\) on public\.bookings to authenticated/)
})

test('booking checkout uses a server-prepared database intent and Test Mode only', () => {
  const route = fs.readFileSync('app/api/bookings/payments/checkout/route.ts', 'utf8')
  assert.match(route, /prepare_booking_payment_attempt/)
  assert.match(route, /getRazorpayTestCredentials/)
  assert.match(route, /record_booking_payment_order/)
  assert.match(route, /attempt\.amount_minor/)
  assert.doesNotMatch(route, /from\('payments'\)/)
})

test('verification fetches provider state and shares atomic confirmation with webhooks', () => {
  const route = fs.readFileSync('app/api/bookings/payments/verify/route.ts', 'utf8')
  assert.match(route, /verifyRazorpayCheckoutSignature/)
  assert.match(route, /v1\/payments\/\$\{encodeURIComponent\(paymentId\)\}/)
  assert.match(route, /matchesCapturedRazorpayPayment/)
  assert.match(route, /confirm_booking_payment/)
  assert.match(route, /get_booking_payment_for_verification/)
})

test('confirmation locks the service and treats duplicate captures idempotently', () => {
  const sql = fs.readFileSync('supabase/migrations/20261125120000_paid_appointment_bookings.sql', 'utf8')
  assert.match(sql, /if p_token is null or p_token !~ '\^\[a-f0-9\]\{48\}\$'/)
  assert.match(sql, /if attempt\.status = 'captured' then/)
  assert.match(sql, /'duplicate', true/)
  assert.match(sql, /pg_advisory_xact_lock/)
  assert.match(sql, /unique \(booking_id, attempt_number\)/)
})

test('customer booking data is reachable only with its opaque token', () => {
  const route = fs.readFileSync('app/api/bookings/customer/[token]/route.ts', 'utf8')
  assert.match(route, /\^\[a-f0-9\]\{48\}\$/)
  assert.match(route, /eq\('public_token', token\)/)
  assert.doesNotMatch(route, /booking_id.*request\.json/)
})

test('webhook claims each event once and releases failed claims for provider retry', () => {
  const route = fs.readFileSync('app/api/webhooks/razorpay/route.ts', 'utf8')
  assert.match(route, /duplicateError\?\.code === '23505'/)
  assert.match(route, /delete\(\)\.eq\('event_id', eventId\)/)
})

test('webhook uses raw-body authentication, dedupe, and the shared booking confirmation RPC', () => {
  const route = fs.readFileSync('app/api/webhooks/razorpay/route.ts', 'utf8')
  assert.match(route, /request\.text\(\)/)
  assert.match(route, /createHmac\('sha256'/)
  assert.match(route, /payment_webhook_events/)
  assert.match(route, /confirm_booking_payment/)
  assert.match(route, /mark_booking_payment_failed/)
  assert.match(route, /mark_order_paid/)
})
