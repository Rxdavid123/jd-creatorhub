'use client'

import { useEffect, useState } from 'react'

type LinkedProduct = { id: string; name: string; price: number | null; currency: string; status: string }
type CourseLink = { product_id: string; products?: LinkedProduct | null }
type Course = { id: string; title: string; slug: string; description: string; price_minor: number; currency: string; status: string; course_product_links?: CourseLink[] }
type Product = { id: string; name: string; price: number | null; currency: string; status: string }

export default function CoursesDashboard() {
  const [courses, setCourses] = useState<Course[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [editing, setEditing] = useState<Course | null>(null)
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('0')
  const [error, setError] = useState('')
  const [linkError, setLinkError] = useState('')
  const [busy, setBusy] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [selectedProduct, setSelectedProduct] = useState<Record<string, string>>({})

  async function load() {
    setLoading(true)
    const [courseResponse, productResponse] = await Promise.all([fetch('/api/courses', { cache: 'no-store' }), fetch('/api/products/owned', { cache: 'no-store' })])
    const courseData = await courseResponse.json()
    const productData = await productResponse.json()
    setCourses(courseData.courses || [])
    setProducts(productData.products || [])
    if (!courseResponse.ok) setError(`Courses request failed (${courseResponse.status}): ${courseData.error || 'Unable to load courses.'}`)
    if (!productResponse.ok) setError(`Products request failed (${productResponse.status}): ${productData.error || 'Unable to load products.'}`)
    if (courseResponse.ok && productResponse.ok && !(productData.products || []).length) setError('No owned products were returned. Confirm your store has a product and that you are signed in as its owner.')
    setLoading(false)
  }

  useEffect(() => { void load() }, [])
  function reset() { setEditing(null); setTitle(''); setSlug(''); setDescription(''); setPrice('0') }
  function edit(course: Course) { setEditing(course); setTitle(course.title); setSlug(course.slug); setDescription(course.description || ''); setPrice((Number(course.price_minor) / 100).toFixed(2)); setError('') }
  async function save() {
    setError(''); setBusy(true)
    const response = await fetch('/api/courses', { method: editing ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: editing?.id, title, slug, description, priceMinor: Math.round(Number(price) * 100), status: editing?.status ?? 'draft' }) })
    const data = await response.json(); setBusy(false)
    if (!response.ok) return setError(data.error || 'Unable to save course.')
    reset(); await load()
  }
  async function linkProduct(course: Course) {
    const productId = selectedProduct[course.id]
    if (!productId) return
    setLinkError(''); setLinkBusy(true)
    const response = await fetch('/api/courses/links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ courseId: course.id, productId }) })
    const data = await response.json(); setLinkBusy(false)
    if (!response.ok) return setLinkError(`Link request failed (${response.status}): ${data.error || 'Unable to link product.'}${data.diagnostic ? ` Diagnostic: ${JSON.stringify(data.diagnostic)}` : ''}`)
    setSelectedProduct(current => ({ ...current, [course.id]: '' })); await load()
  }
  async function unlinkProduct(course: Course) {
    if (!window.confirm('Unlink this product from the course?')) return
    setLinkError(''); setLinkBusy(true)
    const response = await fetch('/api/courses/links', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ courseId: course.id }) })
    const data = await response.json(); setLinkBusy(false)
    if (!response.ok) return setLinkError(`Unlink request failed (${response.status}): ${data.error || 'Unable to unlink product.'}`)
    await load()
  }

  return <main className="min-h-screen bg-[#f8faff] p-5 text-slate-950 lg:p-8"><div className="mx-auto max-w-5xl"><p className="text-sm font-semibold text-blue-600">Creator workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Courses</h1><p className="mt-2 text-slate-500">Build structured learning experiences for your audience.</p><div className="mt-8 grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><section className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">{editing ? 'Edit draft' : 'Create a course'}</h2>{editing && <button type="button" onClick={reset} className="text-sm text-slate-500">Cancel</button>}</div><input value={title} onChange={event => setTitle(event.target.value)} placeholder="Course title" className="mt-4 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"/><input value={slug} onChange={event => setSlug(event.target.value)} placeholder="url-slug" className="mt-3 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"/><textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="Description" className="mt-3 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm"/><label htmlFor="course-price" className="mt-3 block text-sm font-medium text-slate-700">Price (INR)</label><input id="course-price" type="number" min="0" step="0.01" value={price} onChange={event => setPrice(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"/><button disabled={busy} onClick={save} className="mt-4 h-11 w-full rounded-xl bg-blue-500 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : editing ? 'Save draft' : 'Create draft'}</button>{error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}</section><section className="space-y-3">{loading ? <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">Loading courses…</p> : courses.length ? courses.map(course => { const link = course.course_product_links?.[0]; const product = link?.products; const eligibleProducts = products.filter(item => item.status === 'published' && Math.round(Number(item.price ?? 0) * 100) === Number(course.price_minor) && item.currency.toUpperCase() === course.currency.toUpperCase()); return <article key={course.id} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">{course.title}</h2><p className="mt-1 text-sm text-slate-500">/{course.slug} · {course.status}</p></div><button type="button" onClick={() => edit(course)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Edit</button></div>{product ? <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-sm font-semibold text-emerald-800">Product linked</p><p className="mt-1 text-sm text-emerald-700">{product.name} · {product.currency} {product.price ?? 0}</p><button type="button" onClick={() => unlinkProduct(course)} disabled={linkBusy} className="mt-3 text-sm font-semibold text-emerald-800 underline disabled:opacity-50">Unlink product</button></div> : course.status === 'published' ? <div className="mt-5"><label htmlFor={`product-${course.id}`} className="sr-only">Product for {course.title}</label><div className="flex gap-2"><select id={`product-${course.id}`} value={selectedProduct[course.id] || ''} onChange={event => setSelectedProduct(current => ({ ...current, [course.id]: event.target.value }))} className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 px-2 text-sm"><option value="">Select published product</option>{eligibleProducts.map(item => <option key={item.id} value={item.id}>{item.name} · {item.currency} {item.price ?? 0}</option>)}</select><button type="button" disabled={!selectedProduct[course.id] || linkBusy} onClick={() => linkProduct(course)} className="rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Link product</button></div><p className="mt-2 text-xs text-slate-500">Only your published products matching {course.currency} {Number(course.price_minor) / 100} are shown. The API verifies ownership, publication status, price, currency, and duplicate mappings.</p></div> : <p className="mt-5 text-sm text-slate-500">Publish this course to link a product.</p>}{linkError && <p role="alert" className="mt-3 text-sm text-red-600">{linkError}</p>}</article> }) : <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-500">No courses yet.</p>}</section></div></div></main>
}
