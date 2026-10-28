'use client'

import { useEffect, useState } from 'react'

type Course = { id: string; title: string; slug: string; description: string; price_minor: number; status: string }

export default function CoursesDashboard() {
  const [courses, setCourses] = useState<Course[]>([])
  const [editing, setEditing] = useState<Course | null>(null)
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    const response = await fetch('/api/courses', { cache: 'no-store' })
    const data = await response.json()
    setCourses(data.courses || [])
    if (!response.ok) setError(data.error || 'Unable to load courses.')
  }

  useEffect(() => { load() }, [])

  function reset() { setEditing(null); setTitle(''); setSlug(''); setDescription('') }

  function edit(course: Course) {
    setEditing(course); setTitle(course.title); setSlug(course.slug); setDescription(course.description || ''); setError('')
  }

  async function save() {
    setError(''); setBusy(true)
    const response = await fetch('/api/courses', { method: editing ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: editing?.id, title, slug, description }) })
    const data = await response.json()
    setBusy(false)
    if (!response.ok) return setError(data.error || 'Unable to save course.')
    reset(); await load()
  }

  return <main className="min-h-screen bg-[#f8faff] p-5 text-slate-950 lg:p-8"><div className="mx-auto max-w-5xl"><p className="text-sm font-semibold text-blue-600">Creator workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Courses</h1><p className="mt-2 text-slate-500">Build structured learning experiences for your audience.</p><div className="mt-8 grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><section className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">{editing ? 'Edit draft' : 'Create a course'}</h2>{editing && <button type="button" onClick={reset} className="text-sm text-slate-500">Cancel</button>}</div><input value={title} onChange={event => setTitle(event.target.value)} placeholder="Course title" className="mt-4 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"/><input value={slug} onChange={event => setSlug(event.target.value)} placeholder="url-slug" className="mt-3 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"/><textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="Description" className="mt-3 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm"/><button disabled={busy} onClick={save} className="mt-4 h-11 w-full rounded-xl bg-blue-500 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : editing ? 'Save draft' : 'Create draft'}</button>{error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}</section><section className="space-y-3">{courses.length ? courses.map(course => <article key={course.id} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">{course.title}</h2><p className="mt-1 text-sm text-slate-500">/{course.slug} · {course.status}</p></div><button onClick={() => edit(course)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold">Edit</button></div></article>) : <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">No courses yet.</div>}</section></div></div></main>
}
