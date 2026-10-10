'use client'

import { useRef, useState } from 'react'
import { Loader2, Trash2, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type Props = {
  bucket: 'creator-assets' | 'product-files'
  pathPrefix: string
  value: string
  label: string
  onChange: (url: string) => void
}

const MAX_BYTES = 10 * 1024 * 1024
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function StorageImageUpload({ bucket, pathPrefix, value, label, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function upload(file: File) {
    setError('')
    if (!ALLOWED_TYPES.has(file.type)) return setError('Choose a PNG, JPG, WEBP, or GIF image.')
    if (file.size > MAX_BYTES) return setError('Images must be 10 MB or smaller.')
    setBusy(true)
    const client = createClient()
    const { data: userData } = await client.auth.getUser()
    if (!userData.user) { setError('Your session expired. Please sign in again.'); setBusy(false); return }
    const extension = file.name.split('.').pop()?.toLowerCase() || 'bin'
    const path = `${pathPrefix}/${userData.user.id}/${crypto.randomUUID()}.${extension}`
    const result = await client.storage.from(bucket).upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })
    if (result.error) setError('Upload failed. Check the storage bucket policies and try again.')
    else {
      const { data } = client.storage.from(bucket).getPublicUrl(result.data.path)
      onChange(data.publicUrl)
    }
    setBusy(false)
  }

  async function remove() {
    if (!value) return
    setBusy(true)
    const marker = `/${bucket}/`
    const path = value.includes(marker) ? value.split(marker)[1].split('?')[0] : ''
    if (path) {
      const { error: removeError } = await createClient().storage.from(bucket).remove([path])
      if (removeError) {
        setError('Unable to remove the image. Check the storage policies and try again.')
        setBusy(false)
        return
      }
    }
    onChange('')
    setBusy(false)
  }

  return <div className="mt-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3">
    {value && <img src={value} alt={`${label} preview`} className="mb-3 h-28 w-full rounded-lg object-cover" />}
    <div className="flex flex-wrap gap-2">
      <input ref={inputRef} type="file" accept={ACCEPT} className="sr-only" onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file); e.currentTarget.value = '' }} />
      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs font-semibold shadow-sm ring-1 ring-slate-200 disabled:opacity-60"><Upload size={14} />{busy ? <><Loader2 size={14} className="animate-spin" />Uploading…</> : value ? 'Replace image' : 'Upload image'}</button>
      {value && <button type="button" disabled={busy} onClick={() => void remove()} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-red-600 disabled:opacity-60"><Trash2 size={14} />Remove</button>}
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
  </div>
}

export function storageBucketSetupNote() { return null }

