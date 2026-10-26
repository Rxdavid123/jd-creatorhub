import { PurchaseLibrary } from '@/components/purchase-library'

export default async function PurchaseLibraryPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = '' } = await searchParams
  return <PurchaseLibrary token={token} />
}
