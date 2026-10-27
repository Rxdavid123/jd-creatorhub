import type { SupabaseClient } from '@supabase/supabase-js'
import { currentUser } from '@/lib/courses'

export async function grantVerifiedCourseEnrollment(client: SupabaseClient, orderId: string, providerPaymentId: string) {
  const user = await currentUser()
  if (!user?.id || !user.email) return { enrollmentId: null, reason: 'authentication' as const }
  const { data: order, error: orderError } = await client.from('orders').select('customer_email').eq('id', orderId).maybeSingle()
  if (orderError) throw orderError
  if (!order?.customer_email || order.customer_email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return { enrollmentId: null, reason: 'email_mismatch' as const }
  const { data, error } = await client.rpc('grant_course_enrollment', { p_order_id: orderId, p_student_id: user.id, p_provider_payment_id: providerPaymentId })
  if (error) throw error
  return { enrollmentId: data as string | null, reason: data ? null : 'not_granted' as const }
}

export async function courseMappingForProduct(client: SupabaseClient, productId: string) {
  const { data, error } = await client.from('course_product_links').select('course_id').eq('product_id', productId).maybeSingle()
  if (error) throw error
  return data
}
