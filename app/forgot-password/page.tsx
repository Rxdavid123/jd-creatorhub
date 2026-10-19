'use client'

import Link from 'next/link'
import { FormEvent, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    const { error: resetError } = await createClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/dashboard/profile`,
    })
    if (resetError) setError('We could not send a reset email. Check the address and try again.')
    else setMessage('If an account exists for that email, a reset link is on its way.')
    setBusy(false)
  }

  return <main className="flex min-h-screen items-center justify-center bg-[#f8faff] px-5 py-10 text-slate-950"><div className="w-full max-w-md"><Link href="/" className="mb-10 block font-semibold tracking-tight">JD <span className="text-blue-500">CreatorHub</span></Link><div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/30 sm:p-8"><h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1><p className="mt-2 text-sm text-slate-500">We&apos;ll email you a secure link to choose a new password.</p><form onSubmit={submit} className="mt-7 space-y-4"><label className="block text-sm font-medium">Email<input className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" type="email" value={email} onChange={event => setEmail(event.target.value)} required /></label>{error && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}{message && <p role="status" className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</p>}<button disabled={busy} className="w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Sending…' : 'Send reset link'}</button></form><Link href="/login" className="mt-6 block text-center text-sm font-semibold text-blue-600">Back to login</Link></div></div></main>
}
