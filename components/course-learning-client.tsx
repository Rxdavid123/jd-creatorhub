'use client'

import { useState } from 'react'

type Lesson = { id: string; title: string; is_preview?: boolean }
export default function CourseLearningClient({ slug, lessons }: { slug: string; lessons: Lesson[] }) {
  const [selected, setSelected] = useState<Lesson | null>(lessons[0] || null)
  const [content, setContent] = useState('')
  const [message, setMessage] = useState('')
  async function openLesson(lesson: Lesson) {
    setSelected(lesson); setMessage('')
    const response = await fetch(`/api/courses/${slug}/lessons/${lesson.id}`)
    const data = await response.json()
    setContent(response.ok ? data.lesson.content || 'This lesson has no text content.' : data.error || 'Unable to open lesson.')
  }
  async function complete() {
    if (!selected) return
    const response = await fetch(`/api/courses/${slug}/lessons/${selected.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: true }) })
    setMessage(response.ok ? 'Progress saved.' : 'Unable to save progress.')
  }
  return <section className="rounded-2xl border border-slate-200 bg-white p-6"><p className="text-sm text-slate-500">Course workspace</p><h2 className="mt-2 text-2xl font-semibold">{selected?.title || 'Choose a lesson'}</h2><div className="mt-6 min-h-40 whitespace-pre-wrap rounded-xl bg-slate-50 p-5 text-sm leading-7 text-slate-700">{content || 'Choose a lesson from the curriculum to begin.'}</div><div className="mt-5 flex items-center gap-3"><button type="button" onClick={() => selected && openLesson(selected)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold">Load lesson</button><button type="button" onClick={complete} disabled={!selected || selected.is_preview} className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Mark complete</button>{message && <span className="text-sm text-slate-500">{message}</span>}</div><div className="mt-6 grid gap-2">{lessons.map(lesson => <button type="button" key={lesson.id} onClick={() => openLesson(lesson)} className="rounded-lg border border-slate-200 p-3 text-left text-sm hover:border-blue-300">{lesson.title}{lesson.is_preview && <span className="ml-2 text-xs text-blue-600">Preview</span>}</button>)}</div></section>
}
