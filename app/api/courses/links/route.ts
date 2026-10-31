import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { currentUser } from '@/lib/courses'

const json = (body: unknown) => body && typeof body === 'object' ? body as Record<string, unknown> : {}

export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const client = await createClient()
  const { data, error } = await client.from('course_product_links').select('course_id,product_id,created_at,courses!inner(id,title,slug,price_minor,currency,status,owner_id),products!inner(id,name,price,currency,status,store_id)').eq('courses.owner_id', user.id).eq('products.stores.user_id', user.id)
  return error ? NextResponse.json({ error: error.message }, { status: 400 }) : NextResponse.json({ links: data || [] })
}

export async function POST(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const body = json(await request.json().catch(() => null))
  const courseId = typeof body.courseId === 'string' ? body.courseId : ''
  const productId = typeof body.productId === 'string' ? body.productId : ''
  if (!courseId || !productId) return NextResponse.json({ error: 'Course and product are required.' }, { status: 400 })
  const client = await createClient()
  const [{ data: course, error: courseError }, { data: product, error: productError }] = await Promise.all([
    client.from('courses').select('id,status,owner_id,price_minor,currency').eq('id', courseId).eq('owner_id', user.id).maybeSingle(),
    client.from('products').select('id,price,currency,status,store_id,stores!inner(user_id)').eq('id', productId).eq('stores.user_id', user.id).maybeSingle(),
  ])
  if (courseError || productError) {
    console.error('[v0] course product ownership lookup failed', { userId: user.id, courseId, productId, courseCode: courseError?.code, courseMessage: courseError?.message, productCode: productError?.code, productMessage: productError?.message })
    return NextResponse.json({ error: 'Unable to verify course and product ownership.', diagnostic: { courseCode: courseError?.code, productCode: productError?.code } }, { status: 400 })
  }
  if (!course || course.status !== 'published') {
    console.info('[v0] link rejected: course not published or not owned', { userId: user.id, courseId, courseOwnerId: course?.owner_id, courseStatus: course?.status })
    return NextResponse.json({ error: 'Only your published courses can be linked.' }, { status: 400 })
  }
  if (!product || product.status !== 'published') {
    console.info('[v0] link rejected: product not published or not owned', { userId: user.id, productId, productStoreId: product?.store_id, productStatus: product?.status })
    return NextResponse.json({ error: 'Only your published products can be linked.' }, { status: 400 })
  }
  const productMinor = product.price == null ? 0 : Math.round(Number(product.price) * 100)
  if (!Number.isFinite(productMinor) || productMinor !== Number(course.price_minor) || product.currency.toUpperCase() !== course.currency.toUpperCase()) {
    console.info('[v0] link rejected: price or currency mismatch', { userId: user.id, courseId, productId, coursePriceMinor: Number(course.price_minor), productPriceMinor: productMinor, courseCurrency: course.currency, productCurrency: product.currency })
    return NextResponse.json({ error: `Price/currency mismatch. Course: ${course.currency} ${Number(course.price_minor) / 100}; product: ${product.currency} ${Number(product.price ?? 0)}.` }, { status: 400 })
  }
  const { data, error } = await client.from('course_product_links').insert({ course_id: courseId, product_id: productId }).select().single()
  if (error) return NextResponse.json({ error: error.code === '23505' ? 'This course or product is already linked.' : error.message }, { status: 400 })
  return NextResponse.json({ link: data }, { status: 201 })
}

export async function DELETE(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const body = json(await request.json().catch(() => null))
  const courseId = typeof body.courseId === 'string' ? body.courseId : ''
  if (!courseId) return NextResponse.json({ error: 'Course is required.' }, { status: 400 })
  const client = await createClient()
  const { data: course } = await client.from('courses').select('id').eq('id', courseId).eq('owner_id', user.id).maybeSingle()
  if (!course) return NextResponse.json({ error: 'Course not found.' }, { status: 404 })
  const { error } = await client.from('course_product_links').delete().eq('course_id', courseId)
  return error ? NextResponse.json({ error: error.message }, { status: 400 }) : NextResponse.json({ ok: true })
}
