'use client'

import { useEffect, useRef, useState } from 'react'
import { FileText, Loader2, Trash2, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type ProductFile = {
  id: string
  storage_path: string
  original_filename: string
  mime_type: string
  file_size_bytes: number
  created_at: string
}

const MAX_FILE_SIZE = 25 * 1024 * 1024
const ACCEPTED_TYPES = new Set([
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'application/vnd.rar', 'application/x-7z-compressed', 'text/plain',
  'text/csv', 'application/rtf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])
const ACCEPT = '.pdf,.zip,.rar,.7z,.txt,.csv,.rtf,.doc,.docx,.xls,.xlsx,.ppt,.pptx'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ProductFileManager({ productId }: { productId: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<ProductFile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function loadFiles() {
    const { data, error: loadError } = await createClient().from('product_files').select('id,storage_path,original_filename,mime_type,file_size_bytes,created_at').eq('product_id', productId).order('created_at', { ascending: false })
    if (loadError) setError(loadError.message.includes('does not exist') ? 'Apply the product_files migration in Supabase before adding files.' : 'Unable to load private file metadata.')
    else setFiles(data || [])
  }

  useEffect(() => { loadFiles() }, [productId])

  async function upload(file: File) {
    setError('')
    if (!ACCEPTED_TYPES.has(file.type)) { setError('Choose a PDF, document, spreadsheet, presentation, text, archive, or CSV file.'); return }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE) { setError('Files must be between 1 byte and 25 MB.'); return }
    setBusy(true)
    const client = createClient()
    const { data: userData } = await client.auth.getUser()
    if (!userData.user) { setError('Your session expired. Please sign in again.'); setBusy(false); return }
    const extension = file.name.includes('.') ? `.${file.name.split('.').pop()}` : ''
    const storagePath = `${userData.user.id}/${productId}/${crypto.randomUUID()}${extension}`
    const { error: uploadError } = await client.storage.from('product-files').upload(storagePath, file, { contentType: file.type, upsert: false })
    if (uploadError) { setError('Unable to upload the private file. Check the storage policies and try again.'); setBusy(false); return }
    const { error: metadataError } = await client.from('product_files').insert({ product_id: productId, storage_path: storagePath, original_filename: file.name, mime_type: file.type, file_size_bytes: file.size })
    if (metadataError) {
      const { error: cleanupError } = await client.storage.from('product-files').remove([storagePath])
      if (cleanupError) {
        setError('Metadata could not be saved, and the uploaded private file could not be cleaned up. Remove it from Supabase Storage after fixing the database.')
      } else {
        setError(metadataError.message.includes('does not exist') ? 'Apply the product_files migration in Supabase before adding files.' : 'The file upload was rolled back because metadata could not be saved.')
      }
      setBusy(false)
      return
    }
    await loadFiles()
    setBusy(false)
  }

  async function remove(item: ProductFile) {
    if (!window.confirm(`Remove ${item.original_filename}?`)) return
    setBusy(true); setError('')
    const client = createClient()
    const { error: metadataError } = await client.from('product_files').delete().eq('id', item.id).eq('product_id', productId)
    if (metadataError) { setError('Unable to remove the file metadata.'); setBusy(false); return }
    const { error: storageError } = await client.storage.from('product-files').remove([item.storage_path])
    if (storageError) setError('Metadata was removed, but the private storage object could not be removed.')
    await loadFiles(); setBusy(false)
  }

  return <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Private product files</h3><p className="mt-1 text-xs text-slate-500">PDFs and common documents, up to 25 MB. Files stay private.</p></div><button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><Upload size={14} /> Add file</button><input ref={inputRef} type="file" accept={ACCEPT} className="hidden" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) upload(file); event.target.value = '' }} /></div>{error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}{busy && <p className="mt-3 flex items-center gap-2 text-xs text-slate-500"><Loader2 size={13} className="animate-spin" /> Updating private file metadata…</p>}{files.length > 0 && <ul className="mt-4 space-y-2">{files.map(item => <li key={item.id} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2"><span className="flex min-w-0 items-center gap-2 text-xs"><FileText size={14} className="shrink-0 text-blue-500" /><span className="truncate">{item.original_filename}</span><span className="shrink-0 text-slate-400">{formatBytes(item.file_size_bytes)}</span></span><button type="button" disabled={busy} onClick={() => remove(item)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${item.original_filename}`}><Trash2 size={14} /></button></li>)}</ul>}</div>
}

export { MAX_FILE_SIZE }

