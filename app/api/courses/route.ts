import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { currentUser } from '@/lib/courses'

function coursePayload(body: unknown) {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  const slug = typeof value.slug === 'string' ? value.slug.trim().toLowerCase() : ''
  if (!title || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { error: 'Provide a title and URL-safe slug.' as const }
  const priceMinor = value.priceMinor === undefined ? 0 : value.priceMinor
  if (!Number.isInteger(priceMinor) || Number(priceMinor) < 0) return { error: 'Provide a valid non-negative price.' as const }
  return { value: { title, slug, description: typeof value.description === 'string' ? value.description.trim() : '', price_minor: Number(priceMinor), status: 'draft' as const } }
}

export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const { data, error } = await (await createClient()).from('courses').select('*,course_sections(id,course_lessons(id)),course_product_links(product_id)').eq('owner_id', user.id).neq('status', 'deleted').order('updated_at', { ascending: false })
  return error ? NextResponse.json({ error: error.message }, { status: 400 }) : NextResponse.json({ courses: data || [] })
}

export async function POST(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const parsed = coursePayload(await request.json().catch(() => null))
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { data, error } = await (await createClient()).from('courses').insert({ ...parsed.value, owner_id: user.id }).select().single()
  if (error) return NextResponse.json({ error: error.code === '23505' ? 'That slug is already in use.' : error.message }, { status: 400 })
  return NextResponse.json({ course: data }, { status: 201 })
}

export async function PATCH(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!id) return NextResponse.json({ error: 'Course id is required.' }, { status: 400 })
  const parsed = coursePayload(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { data, error } = await (await createClient()).from('courses').update(parsed.value).eq('id', id).eq('owner_id', user.id).select().single()
  if (error) return NextResponse.json({ error: error.code === '23505' ? 'That slug is already in use.' : error.message }, { status: 400 })
  return NextResponse.json({ course: data })
}
