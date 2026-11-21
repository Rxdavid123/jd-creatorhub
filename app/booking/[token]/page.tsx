import { CustomerBookingPanel } from '@/components/booking/customer-booking-panel'

export default async function BookingConfirmation({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <CustomerBookingPanel token={token} />
}
