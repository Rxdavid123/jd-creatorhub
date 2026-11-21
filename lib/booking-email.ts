export type BookingEmailEventType =
  | 'confirmation'
  | 'new_booking'
  | 'creator_confirmation'
  | 'creator_cancellation'
  | 'change_request_submitted'
  | 'change_request_decision'

export type BookingEmailDetails = {
  serviceName: string
  customerName: string
  customerEmail: string
  customerPhone?: string | null
  customerNote?: string | null
  startsAt: string
  timezone: string
  status: string
  requestType?: string | null
  requestReason?: string | null
  requestedStartsAt?: string | null
  requestStatus?: string | null
}

export type BookingEmailRecipient = {
  email: string
  name?: string | null
}

export type BookingEmail = {
  to: string
  replyTo?: string
  subject: string
  html: string
  text: string
}

const statusLabels: Record<string, string> = {
  pending: 'Pending confirmation',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  no_show: 'No show',
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character]
  })
}

function safeHeader(value: string) {
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function formatAppointment(startsAt: string, timezone: string) {
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return { date: startsAt, time: timezone }

  try {
    const appointmentDate = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: timezone,
    }).format(date)
    const appointmentTime = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: timezone,
    }).format(date)
    return { date: appointmentDate, time: `${appointmentTime} (${timezone})` }
  } catch {
    return { date: date.toISOString(), time: timezone }
  }
}

function statusLabel(status: string) {
  return statusLabels[status] ?? (safeHeader(status) || 'Unknown')
}

function emailCopy(eventType: BookingEmailEventType, status: string) {
  if (eventType === 'new_booking') {
    return status === 'pending'
      ? { subject: 'New booking request', intro: 'A customer requested an appointment.' }
      : { subject: 'New booking', intro: 'A customer booked an appointment.' }
  }

  if (eventType === 'creator_cancellation') {
    return { subject: 'Booking cancelled', intro: 'Your appointment has been cancelled.' }
  }

  if (eventType === 'change_request_submitted') {
    return { subject: 'Customer booking change request', intro: 'A customer submitted a booking change request.' }
  }
  if (eventType === 'change_request_decision') {
    return { subject: 'Booking request update', intro: `Your ${status} request has been ${status}.` }
  }

  if (eventType === 'creator_confirmation') {
    return { subject: 'Booking confirmed', intro: 'The creator confirmed your appointment.' }
  }

  if (status === 'confirmed') {
    return { subject: 'Booking confirmed', intro: 'Your appointment is confirmed.' }
  }

  if (status === 'pending') {
    return { subject: 'Booking request received', intro: 'Your appointment request has been received.' }
  }

  return { subject: 'Booking update', intro: 'There is an update to your appointment.' }
}

export function buildBookingEmail(
  eventType: BookingEmailEventType,
  booking: BookingEmailDetails,
  creator: BookingEmailRecipient | null = null,
): BookingEmail | null {
  const isCreatorEmail = eventType === 'new_booking' || eventType === 'change_request_submitted'
  const recipient = isCreatorEmail ? creator?.email : booking.customerEmail
  if (!recipient) return null

  const { date, time } = formatAppointment(booking.startsAt, booking.timezone)
  const copy = emailCopy(eventType, booking.status)
  const serviceName = safeHeader(booking.serviceName) || 'Appointment'
  const greetingName = isCreatorEmail ? creator?.name || 'there' : booking.customerName
  const rows: Array<[string, string]> = [
    ['Service', booking.serviceName],
    ['Date', date],
    ['Time', time],
    ['Booking status', statusLabel(booking.status)],
  ]

  if (isCreatorEmail) {
    rows.push(['Customer', booking.customerName], ['Customer email', booking.customerEmail])
    if (booking.customerPhone) rows.push(['Customer phone', booking.customerPhone])
    if (booking.customerNote) rows.push(['Customer note', booking.customerNote])
  }
  if (booking.requestType) rows.push(['Request', booking.requestType], ['Reason', booking.requestReason || 'Not provided'])
  if (booking.requestedStartsAt) rows.push(['Requested time', formatAppointment(booking.requestedStartsAt, booking.timezone).date + ' at ' + formatAppointment(booking.requestedStartsAt, booking.timezone).time])
  if (booking.requestStatus) rows.push(['Request status', booking.requestStatus])

  const htmlRows = rows.map(([label, value]) => (
    `<tr><th align="left" style="padding:8px 16px 8px 0;color:#475569;font-weight:500;vertical-align:top">${escapeHtml(label)}</th><td style="padding:8px 0;color:#0f172a">${escapeHtml(value)}</td></tr>`
  )).join('')
  const textRows = rows.map(([label, value]) => `${label}: ${value}`).join('\n')
  const text = `Hello ${greetingName},\n\n${copy.intro}\n\n${textRows}\n\nJD CreatorHub`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6"><p>Hello ${escapeHtml(greetingName)},</p><p>${escapeHtml(copy.intro)}</p><table role="presentation" style="border-collapse:collapse">${htmlRows}</table><p style="margin-top:24px;color:#64748b">JD CreatorHub</p></div>`

  return {
    to: recipient,
    ...(isCreatorEmail ? { replyTo: booking.customerEmail } : {}),
    subject: safeHeader(`${copy.subject}: ${serviceName}`),
    html,
    text,
  }
}

export function bookingNotificationIdempotencyKey(notificationId: string) {
  return `booking-notification-${notificationId}`
}
