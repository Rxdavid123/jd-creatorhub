'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { normalizeTime } from '@/lib/booking-availability'

type Service = { id: string; name: string; duration_minutes: number; timezone: string; min_notice_minutes: number; max_advance_days: number; buffer_minutes: number; booking_interval_minutes?: number }
type Interval = { weekday: number; start_time: string; end_time: string; enabled: boolean }
type Block = { id: string; starts_at?: string; ends_at?: string; blocked_date?: string; reason: string | null }
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const field = 'h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100'
const normalizeIntervals = (items: Interval[]): Interval[] => items.map((item) => ({
  ...item,
  start_time: normalizeTime(item.start_time) ?? '',
  end_time: normalizeTime(item.end_time) ?? '',
}))

export default function AvailabilitySettings() {
  const [services, setServices] = useState<Service[]>([])
  const [serviceId, setServiceId] = useState('')
  const [intervals, setIntervals] = useState<Interval[]>([])
  const [blocks, setBlocks] = useState<Block[]>([])
  const [settings, setSettings] = useState({ timezone: 'Asia/Kolkata', min_notice_minutes: 60, max_advance_days: 60, buffer_minutes: 0, booking_interval_minutes: 30 })
  const [blockForm, setBlockForm] = useState({ date: '', start: '', end: '', reason: '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function loadServices() {
    const response = await fetch('/api/bookings/services')
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Unable to load services.')
    const list: Service[] = data.services || []
    setServices(list)
    if (!serviceId && list.length) setServiceId(list[0].id)
  }

  async function loadSettings(id: string) {
    const [availabilityResponse, blocksResponse] = await Promise.all([
      fetch(`/api/bookings/availability?serviceId=${encodeURIComponent(id)}`),
      fetch(`/api/bookings/blocks?serviceId=${encodeURIComponent(id)}`),
    ])
    const [availabilityData, blocksData] = await Promise.all([availabilityResponse.json(), blocksResponse.json()])
    if (!availabilityResponse.ok || !blocksResponse.ok) throw new Error(availabilityData.error || blocksData.error || 'Unable to load availability.')
    setIntervals(normalizeIntervals(availabilityData.availability || []))
    setBlocks(blocksData.blocks || [])
    const service = services.find((item) => item.id === id)
    if (service) setSettings({ timezone: service.timezone, min_notice_minutes: service.min_notice_minutes, max_advance_days: service.max_advance_days, buffer_minutes: service.buffer_minutes, booking_interval_minutes: service.booking_interval_minutes || service.duration_minutes || 30 })
  }

  useEffect(() => { void loadServices().catch((cause) => setError(cause.message)) }, [])
  useEffect(() => { if (serviceId) void loadSettings(serviceId).catch((cause) => setError(cause.message)) }, [serviceId])

  const preview = useMemo(() => weekdays.map((day, weekday) => ({ day, ranges: intervals.filter((item) => item.weekday === weekday && item.enabled) })), [intervals])
  function changeInterval(index: number, patch: Partial<Interval>) { setIntervals((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item)) }

  async function save() {
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch('/api/bookings/availability', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceId, availability: intervals, ...settings }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to save settings.')
      setIntervals(normalizeIntervals(data.availability || []))
      setMessage('Availability settings saved. Public booking slots now use this schedule.')
      await loadServices()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save settings.') }
    finally { setBusy(false) }
  }

  async function addBlock(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const isDate = !blockForm.start && !blockForm.end
      const response = await fetch('/api/bookings/blocks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceId, ...(isDate ? { blockedDate: blockForm.date } : { startsAt: `${blockForm.date}T${blockForm.start}:00`, endsAt: `${blockForm.date}T${blockForm.end}:00`, timezone: settings.timezone }), reason: blockForm.reason }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to add unavailable period.')
      setBlocks((items) => [...items, data.block]); setBlockForm({ date: '', start: '', end: '', reason: '' }); setMessage('Unavailable period added.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to add period.') }
    finally { setBusy(false) }
  }

  async function removeBlock(block: Block) {
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch('/api/bookings/blocks', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceId, id: block.id, kind: block.blocked_date ? 'date' : 'time' }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to remove unavailable period.')
      setBlocks((items) => items.filter((item) => item.id !== block.id)); setMessage('Unavailable period removed.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to remove period.') }
    finally { setBusy(false) }
  }

  return <main className="min-h-screen bg-[#f8faff] p-5 text-slate-950 lg:p-8"><div className="mx-auto max-w-5xl">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-500">Bookings</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Availability</h1><p className="mt-2 text-sm text-slate-500">Choose when customers can book your services.</p></div><a className="text-sm font-semibold text-blue-600 underline" href="/dashboard/bookings">Back to bookings</a></header>
    {message && <p role="status" className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p>}{error && <p role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
    {!services.length ? <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6"><h2 className="font-semibold">Create a service first</h2><p className="mt-2 text-sm text-slate-500">Availability is configured per service. Add a booking service to get started.</p></section> : <>
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5"><label className="block max-w-md text-sm font-medium">Service<select className={`${field} mt-2 w-full`} value={serviceId} onChange={(event) => setServiceId(event.target.value)}>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label></section>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Weekly schedule</h2><p className="mt-1 text-sm text-slate-500">Add one or more working intervals for each day. Use separate intervals to create breaks.</p><div className="mt-5 space-y-4">{weekdays.map((day, weekday) => { const rows = intervals.map((item, index) => ({ item, index })).filter(({ item }) => item.weekday === weekday); const enabled = rows.some(({ item }) => item.enabled); return <div key={day} className="rounded-xl border border-slate-100 p-4"><div className="flex items-center justify-between"><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={enabled} onChange={(event) => { if (!event.target.checked) setIntervals((items) => items.map((item) => item.weekday === weekday ? { ...item, enabled: false } : item)); else if (!rows.length) setIntervals((items) => [...items, { weekday, start_time: '09:00', end_time: '17:00', enabled: true }]); else setIntervals((items) => items.map((item) => item.weekday === weekday ? { ...item, enabled: true } : item)) }} />{day}</label><button type="button" onClick={() => setIntervals((items) => [...items, { weekday, start_time: '13:00', end_time: '17:00', enabled: true }])} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600"><Plus size={14} aria-hidden="true"/>Add interval</button></div>{rows.map(({ item, index }) => <div key={`${day}-${index}`} className={`mt-3 flex flex-wrap items-center gap-2 ${!item.enabled ? 'opacity-50' : ''}`}><input aria-label={`${day} interval start`} type="time" value={item.start_time.slice(0,5)} onChange={(event) => changeInterval(index, { start_time: event.target.value })} className={field} /><span className="text-xs text-slate-400">to</span><input aria-label={`${day} interval end`} type="time" value={item.end_time.slice(0,5)} onChange={(event) => changeInterval(index, { end_time: event.target.value })} className={field} /><button type="button" aria-label={`Remove ${day} interval`} onClick={() => setIntervals((items) => items.filter((_, i) => i !== index))} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={15}/></button></div>)}</div> })}</div></section>
        <div className="space-y-5"><section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Booking rules</h2><div className="mt-4 space-y-3"><label className="block text-sm">Timezone<select className={`${field} mt-1 w-full`} value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })}>{['Asia/Kolkata','UTC','America/Los_Angeles','America/New_York','America/Chicago','Europe/London','Europe/Paris','Asia/Dubai','Asia/Singapore','Australia/Sydney'].map((zone) => <option key={zone}>{zone}</option>)}</select></label><label className="block text-sm">Minimum notice (minutes)<input className={`${field} mt-1 w-full`} type="number" min="0" max="525600" value={settings.min_notice_minutes} onChange={(event) => setSettings({ ...settings, min_notice_minutes: Number(event.target.value) })}/></label><label className="block text-sm">Book ahead (days)<input className={`${field} mt-1 w-full`} type="number" min="1" max="730" value={settings.max_advance_days} onChange={(event) => setSettings({ ...settings, max_advance_days: Number(event.target.value) })}/></label><label className="block text-sm">Buffer between appointments (minutes)<input className={`${field} mt-1 w-full`} type="number" min="0" max="240" value={settings.buffer_minutes} onChange={(event) => setSettings({ ...settings, buffer_minutes: Number(event.target.value) })}/></label><label className="block text-sm">Slot interval (minutes)<input className={`${field} mt-1 w-full`} type="number" min="5" max="240" step="5" value={settings.booking_interval_minutes} onChange={(event) => setSettings({ ...settings, booking_interval_minutes: Number(event.target.value) })}/></label></div><button disabled={busy} onClick={() => void save()} className="mt-5 h-11 w-full rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Saving…' : 'Save availability'}</button></section>
          <section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Weekly preview</h2><p className="mt-1 text-xs text-slate-500">Times shown in {settings.timezone}</p><ul className="mt-4 space-y-2">{preview.map(({ day, ranges }) => <li key={day} className="flex justify-between gap-3 text-sm"><span className="font-medium">{day}</span><span className="text-right text-slate-500">{ranges.length ? ranges.map((range) => `${range.start_time.slice(0,5)}–${range.end_time.slice(0,5)}`).join(', ') : 'Unavailable'}</span></li>)}</ul></section></div>
      </div>
      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Unavailable dates and times</h2><p className="mt-1 text-sm text-slate-500">Block a full date, holiday, leave, or a one-time period in your service timezone.</p><form onSubmit={addBlock} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><label className="text-sm">Date<input required type="date" className={`${field} mt-1 w-full`} value={blockForm.date} onChange={(event) => setBlockForm({ ...blockForm, date: event.target.value })}/></label><label className="text-sm">Start (optional)<input type="time" className={`${field} mt-1 w-full`} value={blockForm.start} onChange={(event) => setBlockForm({ ...blockForm, start: event.target.value })}/></label><label className="text-sm">End (optional)<input type="time" className={`${field} mt-1 w-full`} value={blockForm.end} onChange={(event) => setBlockForm({ ...blockForm, end: event.target.value })}/></label><label className="text-sm">Reason<input className={`${field} mt-1 w-full`} maxLength={200} placeholder="Holiday, personal leave" value={blockForm.reason} onChange={(event) => setBlockForm({ ...blockForm, reason: event.target.value })}/></label><button disabled={busy} className="self-end h-10 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50">Add unavailable time</button></form><div className="mt-4 space-y-2">{blocks.map((block) => <div key={block.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 px-4 py-3 text-sm"><div><p className="font-medium">{block.blocked_date || `${new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:settings.timezone}).format(new Date(block.starts_at!))} – ${new Intl.DateTimeFormat('en-US',{timeStyle:'short',timeZone:settings.timezone}).format(new Date(block.ends_at!))}`}</p>{block.reason && <p className="mt-0.5 text-xs text-slate-500">{block.reason}</p>}</div><button type="button" disabled={busy} onClick={() => void removeBlock(block)} className="text-xs font-semibold text-red-600 underline">Remove</button></div>)}{!blocks.length && <p className="py-3 text-sm text-slate-500">No dates or times blocked.</p>}</div></section>
    </>}
  </div></main>
}
