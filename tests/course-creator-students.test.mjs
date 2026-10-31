import assert from 'node:assert/strict'
import fs from 'node:fs'
const route = fs.readFileSync('app/api/courses/students/route.ts', 'utf8')
assert.match(route, /currentUser\(\)/)
assert.match(route, /courses\.owner_id/)
assert.match(route, /course_enrollments/)
console.log('course creator student checks passed')
