import { ProductData } from '@/components/supabase-store-features'

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <ProductData slug={decodeURIComponent(slug)} />
}
