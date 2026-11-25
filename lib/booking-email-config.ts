export type BookingEmailConfigurationInput = {
  apiKey?: string
  fromEmail?: string
  domain?: string
}

export type BookingEmailConfiguration =
  | { configured: true; from: string }
  | { configured: false; reason: 'resend_api_key_missing' | 'sender_missing' }

export function resolveBookingEmailConfiguration(
  input: BookingEmailConfigurationInput,
): BookingEmailConfiguration {
  if (!input.apiKey?.trim()) return { configured: false, reason: 'resend_api_key_missing' }

  const configuredSender = input.fromEmail?.trim()
  if (configuredSender) return { configured: true, from: configuredSender }

  const domain = input.domain?.trim()
  if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) {
    return { configured: false, reason: 'sender_missing' }
  }

  return { configured: true, from: `JD CreatorHub <bookings@${domain}>` }
}
