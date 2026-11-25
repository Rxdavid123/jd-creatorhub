import { createClient } from '@supabase/supabase-js'
import { isRazorpayTestKey } from '@/lib/razorpay-booking-security'

export function createBookingPaymentAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) throw new Error('Booking payment server configuration is missing.')
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

export function getRazorpayTestCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID
  const keySecret = process.env.RAZORPAY_KEY_SECRET
  if (!isRazorpayTestKey(keyId) || !keySecret) throw new Error('Razorpay Test Mode is not configured.')
  return {
    keyId,
    keySecret,
    authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
  }
}
