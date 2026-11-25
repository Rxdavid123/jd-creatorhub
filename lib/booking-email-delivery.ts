import 'server-only'

import { createClient } from '@supabase/supabase-js'
import { resolveBookingEmailConfiguration } from '@/lib/booking-email-config'
import {
  bookingNotificationIdempotencyKey,
  buildBookingEmail,
  type BookingEmailEventType,
  type BookingEmailRecipient,
} from '@/lib/booking-email'

const MAX_DELIVERY_ATTEMPTS = 5
const SENDING_LEASE_MS = 10 * 60 * 1000
const EMAIL_EVENT_TYPES: BookingEmailEventType[] = [
  'confirmation',
  'new_booking',
  'creator_confirmation',
  'creator_cancellation',
  'change_request_submitted',
  'change_request_decision',
]

export type BookingEmailDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'not_configured'

export type BookingEmailDeliveryResult = {
  id: string
  status: BookingEmailDeliveryStatus | 'missing' | 'unsupported'
  reason?: string
}

function createAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase server configuration is missing.')

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function logDeliveryError(eventId: string, reason: string, code?: string | null) {
  console.error('[booking-email] notification processing failed', {
    notificationId: eventId,
    reason,
    ...(code ? { code } : {}),
  })
}

async function updateNotification(
  client: ReturnType<typeof createAdminClient>,
  eventId: string,
  values: Record<string, unknown>,
) {
  const { error } = await client
    .from('booking_notifications')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('id', eventId)
    .eq('status', 'sending')

  if (error) logDeliveryError(eventId, 'notification_state_update_failed', error.code)
  return !error
}

async function failNotification(
  client: ReturnType<typeof createAdminClient>,
  eventId: string,
  reason: string,
): Promise<BookingEmailDeliveryResult> {
  await updateNotification(client, eventId, { status: 'failed', last_error: reason })
  return { id: eventId, status: 'failed', reason }
}

function isEmailEventType(value: string): value is BookingEmailEventType {
  return EMAIL_EVENT_TYPES.includes(value as BookingEmailEventType)
}

async function deliverWithClient(
  client: ReturnType<typeof createAdminClient>,
  eventId: string,
): Promise<BookingEmailDeliveryResult> {
  const { data: notification, error: notificationError } = await client
    .from('booking_notifications')
    .select('id,booking_id,notification_type,status,attempt_count,scheduled_for,change_request_id')
    .eq('id', eventId)
    .maybeSingle()

  if (notificationError) {
    logDeliveryError(eventId, 'notification_lookup_failed', notificationError.code)
    return { id: eventId, status: 'missing', reason: 'notification_lookup_failed' }
  }
  if (!notification) return { id: eventId, status: 'missing' }
  if (!isEmailEventType(notification.notification_type)) {
    return { id: eventId, status: 'unsupported', reason: 'unsupported_notification_type' }
  }
  if (notification.status === 'sent') return { id: eventId, status: 'sent' }
  if (notification.status === 'not_configured') return { id: eventId, status: 'not_configured' }
  if (!['pending', 'failed', 'sending'].includes(notification.status)) {
    return { id: eventId, status: 'unsupported', reason: 'unsupported_notification_status' }
  }

  const now = Date.now()
  const staleBefore = new Date(now - SENDING_LEASE_MS).toISOString()
  const isStaleSending = notification.status === 'sending'
    && Date.parse(notification.scheduled_for) < now - SENDING_LEASE_MS
  if (notification.status === 'sending' && !isStaleSending) {
    return { id: eventId, status: 'sending' }
  }

  if (notification.attempt_count >= MAX_DELIVERY_ATTEMPTS) {
    if (isStaleSending) {
      await updateNotification(client, eventId, { status: 'failed', last_error: 'retry_limit_reached' })
    }
    return { id: eventId, status: 'failed', reason: 'retry_limit_reached' }
  }

  const claimedAt = new Date(now).toISOString()
  let claimQuery = client
    .from('booking_notifications')
    .update({
      status: 'sending',
      attempt_count: notification.attempt_count + 1,
      scheduled_for: claimedAt,
      last_error: null,
      updated_at: claimedAt,
    })
    .eq('id', eventId)
    .eq('attempt_count', notification.attempt_count)

  claimQuery = isStaleSending
    ? claimQuery.eq('status', 'sending').lt('scheduled_for', staleBefore)
    : claimQuery.eq('status', notification.status)

  const { data: claimed, error: claimError } = await claimQuery.select('id').maybeSingle()
  if (claimError) {
    logDeliveryError(eventId, 'notification_claim_failed', claimError.code)
    return { id: eventId, status: notification.status as BookingEmailDeliveryStatus, reason: 'notification_claim_failed' }
  }
  if (!claimed) {
    return { id: eventId, status: notification.status as BookingEmailDeliveryStatus }
  }

  const { data: booking, error: bookingError } = await client
    .from('bookings')
    .select('id,creator_id,customer_name,customer_email,customer_phone,customer_note,starts_at,timezone,status,payment_status,price_minor,currency,booking_services(name)')
    .eq('id', notification.booking_id)
    .maybeSingle()

  if (bookingError || !booking) {
    logDeliveryError(eventId, 'booking_lookup_failed', bookingError?.code)
    return failNotification(client, eventId, 'booking_context_unavailable')
  }

  const serviceRelation = booking.booking_services
  const service = Array.isArray(serviceRelation) ? serviceRelation[0] : serviceRelation
  if (!service?.name) return failNotification(client, eventId, 'service_context_unavailable')

  if (
    (notification.notification_type === 'creator_confirmation' && booking.status !== 'confirmed')
    || (notification.notification_type === 'creator_cancellation' && booking.status !== 'cancelled')
    || (notification.notification_type === 'confirmation' && booking.status === 'cancelled')
  ) {
    return failNotification(client, eventId, 'superseded_by_newer_booking_status')
  }

  let requestDetails: { request_type: string; reason: string; requested_starts_at: string | null; status: string } | null = null
  if (notification.notification_type === 'change_request_submitted' || notification.notification_type === 'change_request_decision') {
    if (!notification.change_request_id) return failNotification(client, eventId, 'request_context_unavailable')
    const { data: request } = await client.from('booking_change_requests').select('request_type,reason,requested_starts_at,status').eq('id', notification.change_request_id).maybeSingle()
    if (!request) return failNotification(client, eventId, 'request_context_unavailable')
    requestDetails = request
  }

  let creator: BookingEmailRecipient | null = null
  if (notification.notification_type === 'new_booking' || notification.notification_type === 'change_request_submitted') {
    const { data: creatorResult, error: creatorError } = await client.auth.admin.getUserById(booking.creator_id)
    if (creatorError || !creatorResult.user?.email) {
      logDeliveryError(eventId, 'creator_recipient_lookup_failed', creatorError?.status?.toString())
      return failNotification(client, eventId, 'creator_email_unavailable')
    }

    const metadata = creatorResult.user.user_metadata ?? {}
    const creatorName = typeof metadata.full_name === 'string'
      ? metadata.full_name
      : typeof metadata.name === 'string'
        ? metadata.name
        : null
    creator = { email: creatorResult.user.email, name: creatorName }
  }

  const email = buildBookingEmail(notification.notification_type, {
    serviceName: service.name,
    priceMinor: Number(booking.price_minor),
    currency: booking.currency,
    paymentStatus: booking.payment_status,
    customerName: booking.customer_name,
    customerEmail: booking.customer_email,
    customerPhone: booking.customer_phone,
    customerNote: booking.customer_note,
    startsAt: booking.starts_at,
    timezone: booking.timezone,
    status: booking.status,
    requestType: requestDetails?.request_type,
    requestReason: requestDetails?.reason,
    requestedStartsAt: requestDetails?.requested_starts_at,
    requestStatus: requestDetails?.status,
  }, creator)

  if (!email) return failNotification(client, eventId, 'recipient_unavailable')

  const emailConfiguration = resolveBookingEmailConfiguration({
    apiKey: process.env.RESEND_API_KEY,
    fromEmail: process.env.RESEND_FROM_EMAIL,
    domain: process.env.RESEND_EMAIL_DOMAIN,
  })
  if (!emailConfiguration.configured) {
    logDeliveryError(eventId, emailConfiguration.reason)
    return failNotification(client, eventId, emailConfiguration.reason)
  }

  const apiKey = process.env.RESEND_API_KEY as string
  const from = emailConfiguration.from
  let response: Response
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': bookingNotificationIdempotencyKey(eventId),
      },
      body: JSON.stringify({
        from,
        to: [email.to],
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      signal: AbortSignal.timeout(8_000),
    })
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? 'provider_timeout'
      : 'provider_network_error'
    logDeliveryError(eventId, reason)
    return failNotification(client, eventId, reason)
  }

  if (!response.ok) {
    const reason = `provider_http_${response.status}`
    logDeliveryError(eventId, reason)
    return failNotification(client, eventId, reason)
  }

  const payload = await response.json().catch(() => null) as { id?: unknown } | null
  const providerMessageId = typeof payload?.id === 'string' ? payload.id : null
  const { error: sentError } = await client
    .from('booking_notifications')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      provider_message_id: providerMessageId,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', eventId)
    .eq('status', 'sending')

  if (sentError) {
    logDeliveryError(eventId, 'notification_state_update_failed', sentError.code)
    return { id: eventId, status: 'sending', reason: 'notification_state_update_failed' }
  }

  return { id: eventId, status: 'sent' }
}

export async function deliverBookingNotification(eventId: string) {
  return deliverWithClient(createAdminClient(), eventId)
}

export async function deliverBookingNotificationsForBooking(
  bookingId: string,
  notificationTypes: BookingEmailEventType[],
) {
  if (!notificationTypes.length) return

  const client = createAdminClient()
  const { data: notifications, error } = await client
    .from('booking_notifications')
    .select('id')
    .eq('booking_id', bookingId)
    .in('notification_type', notificationTypes)
    .in('status', ['pending', 'failed'])

  if (error) {
    logDeliveryError(bookingId, 'pending_notification_lookup_failed', error.code)
    return
  }

  await Promise.all(notifications.map((notification) => deliverWithClient(client, notification.id)))
}
