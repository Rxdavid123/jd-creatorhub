import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { currentUser } from '@/lib/courses'

export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const { data, error } = await (await createClient()).from('products').select('id,name,price,currency,status,store_id,stores!inner(user_id)').eq('stores.user_id', user.id).order('created_at', { ascending: false })
  return error ? NextResponse.json({ error: error.message }, { status: 400 }) : NextResponse.json({ products: data || [] })
}
