export type SupabaseBookingError = {
  code?: string | null
  message?: string | null
}

export type PublicBookingErrorResponse = {
  code: string
  message: string
  status: number
}

const knownRpcErrors: Record<string, PublicBookingErrorResponse> = {
  service_unavailable: {
    code: 'SERVICE_UNAVAILABLE',
    message: 'This service is no longer available.',
    status: 404,
  },
  invalid_customer: {
    code: 'INVALID_CUSTOMER',
    message: 'Please check your name and email address.',
    status: 400,
  },
  outside_booking_window: {
    code: 'OUTSIDE_BOOKING_WINDOW',
    message: 'Choose a time within the booking window.',
    status: 400,
  },
  outside_availability: {
    code: 'OUTSIDE_AVAILABILITY',
    message: 'That time is outside working hours.',
    status: 400,
  },
  blocked_date: {
    code: 'BLOCKED_DATE',
    message: 'That date is unavailable.',
    status: 400,
  },
  blocked_time: {
    code: 'BLOCKED_TIME',
    message: 'That time is blocked.',
    status: 400,
  },
  slot_taken: {
    code: 'SLOT_CONFLICT',
    message: 'That time was just booked. Choose another slot.',
    status: 409,
  },
}

const temporaryFailure: PublicBookingErrorResponse = {
  code: 'BOOKING_TEMPORARILY_UNAVAILABLE',
  message: "We couldn't complete this booking right now. Please try again shortly or contact the service owner.",
  status: 503,
}

export function resolvePublicBookingRpcError(error: SupabaseBookingError): PublicBookingErrorResponse {
  const known = error.message ? knownRpcErrors[error.message.trim()] : undefined
  if (known) return known

  if (error.code === '23514') {
    return {
      code: 'BOOKING_DETAILS_REJECTED',
      message: 'Please check your booking details and try again.',
      status: 400,
    }
  }

  if (error.code === '23505') {
    return knownRpcErrors.slot_taken
  }

  return temporaryFailure
}

export function buildPublicBookingConfirmation(data: unknown) {
  const booking = Array.isArray(data) ? data[0] : data
  if (!booking || typeof booking !== 'object' || Array.isArray(booking)) return null

  const record = booking as Record<string, unknown>
  if (typeof record.public_token !== 'string' || !record.public_token) return null

  return {
    booking: record,
    confirmationUrl: `/booking/${encodeURIComponent(record.public_token)}`,
  }
}

export function redactPublicBookingDiagnostic(message: string, sensitiveValues: string[] = []) {
  let redacted = message
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)/g, '[redacted-number]')

  for (const value of sensitiveValues) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    redacted = redacted.replace(new RegExp(escaped, 'gi'), '[redacted]')
  }

  return redacted.slice(0, 500)
}

export function getSafeBookingFailure(error: unknown, sensitiveValues: string[] = []) {
  const errorRecord = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const code = typeof errorRecord?.code === 'string' ? errorRecord.code : null
  const rawMessage = typeof errorRecord?.message === 'string'
    ? errorRecord.message
    : error instanceof Error
      ? error.message
      : String(error)

  return {
    code,
    message: redactPublicBookingDiagnostic(rawMessage, sensitiveValues),
  }
}
