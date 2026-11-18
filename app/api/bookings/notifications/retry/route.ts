import { NextResponse } from 'next/server'
import { deliverBookingNotification } from '@/lib/booking-email-delivery'
import { createClient } from '@/lib/supabase/server'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const emailNotificationTypes = ['confirmation', 'new_booking', 'creator_confirmation', 'creator_cancellation']

export async function POST(request: Request) {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null) as { notificationId?: unknown } | null
  if (!body || typeof body.notificationId !== 'string' || !uuidPattern.test(body.notificationId)) {
    return NextResponse.json({ error: 'A valid notification ID is required.' }, { status: 400 })
  }

  const { data: notification, error: notificationError } = await client
    .from('booking_notifications')
    .select('id,booking_id,notification_type,status,attempt_count,scheduled_for,last_error')
    .eq('id', body.notificationId)
    .maybeSingle()

  if (notificationError) {
    return NextResponse.json({ error: 'Unable to verify notification ownership.' }, { status: 500 })
  }
  if (!notification || !emailNotificationTypes.includes(notification.notification_type)) {
    return NextResponse.json({ error: 'Notification not found.' }, { status: 404 })
  }

  const { data: booking, error: bookingError } = await client
    .from('bookings')
    .select('id')
    .eq('id', notification.booking_id)
    .eq('creator_id', user.id)
    .maybeSingle()

  if (bookingError) return NextResponse.json({ error: 'Unable to verify booking ownership.' }, { status: 500 })
  if (!booking) return NextResponse.json({ error: 'Notification not found.' }, { status: 404 })

  if (notification.last_error === 'superseded_by_newer_booking_status') {
    return NextResponse.json({ error: 'A newer booking status has superseded this notification.' }, { status: 409 })
  }
  if (!['pending', 'failed', 'sending', 'sent'].includes(notification.status)) {
    return NextResponse.json({ error: 'This notification cannot be retried.' }, { status: 409 })
  }
  if (notification.status !== 'sent' && notification.attempt_count >= 5) {
    return NextResponse.json({ error: 'The retry limit has been reached.' }, { status: 409 })
  }

  const result = await deliverBookingNotification(notification.id)
  return NextResponse.json({ status: result.status, reason: result.reason ?? null })
}
