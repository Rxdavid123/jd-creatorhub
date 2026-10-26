import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

export function adminClient() { return createAdminClient(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } }) }
export async function currentUser() { const { data } = await (await createClient()).auth.getUser(); return data.user }
export async function ownedCourse(courseId: string) { const user = await currentUser(); if (!user) return null; const { data } = await adminClient().from('courses').select('*').eq('id', courseId).eq('owner_id', user.id).maybeSingle(); return data }
export async function courseBySlug(slug: string) { const { data } = await adminClient().from('courses').select('*,course_sections(*,course_lessons(*,course_resources(*)))').eq('slug', slug).eq('status', 'published').maybeSingle(); return data }
export async function enrolledCourse(courseId: string) { const user = await currentUser(); if (!user) return null; return (await adminClient().from('course_enrollments').select('*,courses(*,course_sections(*,course_lessons(*)))').eq('course_id', courseId).eq('student_id', user.id).in('payment_status', ['free','captured']).maybeSingle()).data }
