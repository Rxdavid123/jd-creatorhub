import assert from 'node:assert/strict'
import fs from 'node:fs'
const route = fs.readFileSync('app/api/courses/reconcile/route.ts', 'utf8')
const webhook = fs.readFileSync('app/api/webhooks/razorpay/route.ts', 'utf8')
assert.match(route, /currentUser\(\)/)
assert.match(route, /provider_payment_id/)
assert.match(route, /grant_course_enrollment/)
assert.match(route, /customer_email/)
assert.match(webhook, /payment_webhook_events/)
assert.match(webhook, /mark_order_paid/)
console.log('course reconciliation checks passed')
