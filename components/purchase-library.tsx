'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, PackageOpen } from 'lucide-react'
import { SecureDownloads } from '@/components/secure-downloads'

type LibraryData = { entitlement: { purchasedAt: string; expiresAt: string; quantity: number }; product: { id: string; name: string; slug: string; description: string | null; thumbnail_url: string | null; storeName: string | null } }

export function PurchaseLibrary({ token }: { token: string }) {
  const [data, setData] = useState<LibraryData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/purchase-library?token=${encodeURIComponent(token)}`, { cache: 'no-store', signal: controller.signal }).then(async response => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'Unable to load your purchase.'); setData(payload) }).catch(reason => { if (reason.name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'Unable to load your purchase.') }).finally(() => setLoading(false))
    return () => controller.abort()
  }, [token])

  if (loading) return <div className="flex min-h-[60vh] items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" /> Loading your purchase library…</div>
  if (error || !data) return <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5"><p className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error || 'Purchase access is unavailable.'}</p><Link href="/" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><ArrowLeft size={16} /> Back home</Link></main>

  return <main className="min-h-screen bg-[#f8faff] px-5 py-8 text-slate-950"><div className="mx-auto max-w-xl"><Link href="/" className="font-semibold tracking-tight">JD <span className="text-blue-500">CreatorHub</span></Link><section className="mt-14 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"><div className="flex items-start gap-4"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><PackageOpen size={23} /></div><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-500">Purchase library</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">{data.product.name}</h1><p className="mt-2 text-sm text-slate-500">{data.product.storeName ? `Purchased from ${data.product.storeName}.` : 'Your verified digital purchase.'}</p></div></div><p className="mt-6 text-sm leading-6 text-slate-600">{data.product.description || 'Your purchase is ready to access.'}</p><SecureDownloads token={token} productId={data.product.id} /><p className="mt-5 text-xs text-slate-400">This guest library link expires {new Date(data.entitlement.expiresAt).toLocaleDateString()}. Download links expire after one minute and can be refreshed while access remains valid.</p></section></div></main>
}
