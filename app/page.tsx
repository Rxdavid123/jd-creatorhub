import { RoutedApp } from '@/components/creatorhub-app'

export default function Page() {
  return <RoutedApp />
}

export const dynamic = 'force-dynamic'

// Supabase integration boundary: auth and data queries will be added behind the UI
// once the connected project's schema is available.
// Public creator and product routes intentionally render without private data.

export const metadata = {
  title: 'JD CreatorHub — Your creator business, one powerful platform',
  description: 'Create your storefront, sell digital products, manage customers and grow your online business from one place.',
}
