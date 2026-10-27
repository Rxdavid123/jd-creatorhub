import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync('supabase/migrations/20261027000000_link_course_products_and_storage.sql', 'utf8')
const verify = fs.readFileSync('app/api/payments/razorpay/verify/route.ts', 'utf8')
const lesson = fs.readFileSync('app/api/courses/[slug]/lessons/[lessonId]/route.ts', 'utf8')
assert.match(migration, /on conflict \(course_id, student_id\)/)
assert.match(migration, /status = 'captured'/)
assert.match(migration, /c\.status = 'published'/)
assert.match(migration, /c\.price_minor = v_item\.unit_price_minor/)
assert.match(lesson, /Purchase required/)
assert.doesNotMatch(verify, /body\.(price|currency|courseId)/)
console.log('course payment security checks passed')
