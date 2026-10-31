import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { currentUser } from '@/lib/courses'

export async function POST(request: Request) {
  const user = await currentUser()
  if (!user?.id || !user.email) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const body = await request.json().catch(() => null)
  const providerPaymentId = typeof body?.providerPaymentId === 'string' ? body.providerPaymentId.trim() : ''
  if (!providerPaymentId) return NextResponse.json({ error: 'Payment reference is required.' }, { status: 400 })
  const client = await createClient()
  const { data: payment, error } = await client.from('payments').select('id,order_id,provider_payment_id,status').eq('provider', 'razorpay').eq('provider_payment_id', providerPaymentId).maybeSingle()
  if (error) return NextResponse.json({ error: 'Unable to verify payment record.' }, { status: 500 })
  if (!payment || payment.status !== 'captured') return NextResponse.json({ error: 'Captured payment not found.' }, { status: 404 })
  const { data: order } = await client.from('orders').select('customer_email').eq('id', payment.order_id).maybeSingle()
  if (!order?.customer_email || order.customer_email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return NextResponse.json({ error: 'Payment does not belong to this account.' }, { status: 403 })
  const { data: item } = await client.from('order_items').select('product_id').eq('order_id', payment.order_id).maybeSingle()
  if (!item?.product_id) return NextResponse.json({ error: 'Purchased product not found.' }, { status: 409 })
  const { data: mapping } = await client.from('course_product_links').select('course_id').eq('product_id', item.product_id).maybeSingle()
  if (!mapping) return NextResponse.json({ error: 'This payment is not linked to a course.' }, { status: 409 })
  const { data: enrollment, error: enrollmentError } = await client.rpc('grant_course_enrollment', { p_order_id: payment.order_id, p_student_id: user.id, p_provider_payment_id: providerPaymentId })
  if (enrollmentError) return NextResponse.json({ error: 'Enrollment reconciliation failed.' }, { status: 500 })
  if (!enrollment) return NextResponse.json({ error: 'Payment could not be reconciled for course access.' }, { status: 409 })
  return NextResponse.json({ ok: true, enrollmentId: enrollment })
}
