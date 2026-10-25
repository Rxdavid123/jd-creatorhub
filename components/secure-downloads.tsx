'use client'

import { useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'

type DownloadItem = { id: string; name: string; mimeType: string; url: string; expiresIn: number }

export function SecureDownloads({ token, productId }: { token: string; productId: string }) {
  const [files, setFiles] = useState<DownloadItem[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/download?token=${encodeURIComponent(token)}&productId=${encodeURIComponent(productId)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Unable to prepare your download.')
        setFiles(data.downloads || [])
      })
      .catch(reason => { if (reason.name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'Unable to prepare your download.') })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [productId, token])

  if (loading) return <div className="mt-6 flex items-center gap-2 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700"><Loader2 size={16} className="animate-spin" /> Preparing your secure download…</div>
  if (error) return <p role="alert" className="mt-6 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
  if (!files.length) return <p className="mt-6 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">Your payment is confirmed, but the creator has not attached a downloadable file yet.</p>
  return <section aria-label="Purchased downloads" className="mt-6 rounded-2xl border border-emerald-100 bg-emerald-50 p-4"><h2 className="font-semibold text-emerald-950">Your secure downloads</h2><p className="mt-1 text-xs text-emerald-800">Each link expires after one minute. Request a fresh link from this page when needed.</p><ul className="mt-3 space-y-2">{files.map(file => <li key={file.id}><a href={file.url} className="flex items-center gap-2 rounded-xl bg-white px-3 py-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"><Download size={16} /> <span className="truncate">{file.name}</span></a></li>)}</ul></section>
}
