import { StorefrontData } from '@/components/supabase-store-features'

export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params
  return <StorefrontData username={decodeURIComponent(username)} />
}
