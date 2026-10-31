import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { currentUser } from '@/lib/courses'

export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  const { data, error } = await (await createClient()).from('products').select('id,name,price,currency,status,store_id,stores!inner(user_id)').eq('stores.user_id', user.id).order('created_at', { ascending: false })
  if (error) {
    console.error('[v0] owned products failed', { userId: user.id, code: error.code, message: error.message, details: error.details, hint: error.hint })
    return NextResponse.json({ error: 'Unable to load your products.', diagnostic: { code: error.code } }, { status: 400 })
  }
  console.info('[v0] owned products', { userId: user.id, count: data?.length || 0, publishedCount: data?.filter(product => product.status === 'published').length || 0 })
  return NextResponse.json({ products: data || [] })
}
