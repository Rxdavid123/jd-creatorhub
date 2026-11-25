export const BOOKING_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'AUD', 'CAD', 'SGD'] as const

export type BookingCurrency = (typeof BOOKING_CURRENCIES)[number]

export function isBookingCurrency(value: unknown): value is BookingCurrency {
  return typeof value === 'string' && BOOKING_CURRENCIES.includes(value as BookingCurrency)
}

export function parseMajorAmount(value: string, currency: string) {
  if (!isBookingCurrency(currency)) return null
  const normalized = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) return null
  const [whole, fraction = ''] = normalized.split('.')
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(minor) ? minor : null
}

export function formatMinorAmount(amountMinor: number, currency: string) {
  if (!Number.isSafeInteger(amountMinor) || !isBookingCurrency(currency)) return `${currency} ${(amountMinor / 100).toFixed(2)}`
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}
