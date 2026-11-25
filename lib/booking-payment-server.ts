import { createClient } from '@supabase/supabase-js'
import { getRazorpayTestConfigurationErrorCode, type RazorpayConfigurationErrorCode } from '@/lib/razorpay-booking-security'

export function createBookingPaymentAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) throw new Error('Booking payment server configuration is missing.')
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

export class RazorpayConfigurationError extends Error {
  constructor(readonly code: RazorpayConfigurationErrorCode) {
    super('Razorpay Test Mode is not configured.')
    this.name = 'RazorpayConfigurationError'
  }
}

export function getRazorpayTestCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID
  const keySecret = process.env.RAZORPAY_KEY_SECRET
  const errorCode = getRazorpayTestConfigurationErrorCode(keyId, keySecret)
  if (errorCode) throw new RazorpayConfigurationError(errorCode)
  return {
    keyId: keyId as string,
    keySecret: keySecret as string,
    authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
  }
}
