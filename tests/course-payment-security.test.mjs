import assert from 'node:assert/strict'
import fs from 'node:fs'
const migration = fs.readFileSync('supabase/migrations/20261027100000_fix_course_payment_and_storage_policies.sql', 'utf8')
const verify = fs.readFileSync('app/api/payments/razorpay/verify/route.ts', 'utf8')
const helper = fs.readFileSync('lib/course-enrollment.ts', 'utf8')
const courseSchema = fs.readFileSync('supabase/migrations/20261026000000_add_courses.sql', 'utf8')
assert.match(courseSchema, /references public\.payments\(id\)/)
for (const text of ['quantity <> 1', 'line_total_minor <> v_item.unit_price_minor', "v_order.status = 'cancelled'", "status = 'captured'", 'SECURITY DEFINER', "SET search_path = ''", 'GRANT EXECUTE ON FUNCTION']) assert.match(migration, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
for (const text of ['course_files_declared_insert', 'r.storage_path = name', 'c.owner_id']) assert.match(migration, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
assert.match(verify, /courseMappingForProduct/)
assert.match(verify, /course access could not be granted/)
assert.match(verify, /Course orders must contain exactly one product/)
assert.match(helper, /email_mismatch/)
console.log('course payment security checks passed')
