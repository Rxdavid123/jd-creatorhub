import Link from 'next/link'

export default function SettingsPage() {
  return <main className="min-h-screen bg-[#f8faff] px-5 py-8 text-slate-950"><div className="mx-auto max-w-4xl"><Link href="/dashboard" className="text-sm text-slate-500">← Dashboard</Link><div className="mt-8"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-500">JD CreatorHub</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Settings</h1><p className="mt-2 text-sm text-slate-500">Manage your CreatorHub preferences.</p></div><section className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm"><h2 className="text-lg font-semibold">Coming Soon</h2><p className="mt-2 text-sm text-slate-500">Account and notification settings are being prepared.</p></section></div></main>
}
