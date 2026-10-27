import type { SupabaseClient } from '@supabase/supabase-js'
import { currentUser } from '@/lib/courses'

export async function grantVerifiedCourseEnrollment(client: SupabaseClient, orderId: string, providerPaymentId: string) {
  const user = await currentUser()
  if (!user?.id || !user.email) return null
  const { data: order } = await client.from('orders').select('customer_email').eq('id', orderId).maybeSingle()
  if (!order?.customer_email || order.customer_email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return null
  const { data, error } = await client.rpc('grant_course_enrollment', { p_order_id: orderId, p_student_id: user.id, p_provider_payment_id: providerPaymentId })
  if (error) throw error
  return data as string | null
}
