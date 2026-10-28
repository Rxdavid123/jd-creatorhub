import assert from 'node:assert/strict'
import fs from 'node:fs'
const route = fs.readFileSync('app/api/courses/route.ts', 'utf8')
const page = fs.readFileSync('app/dashboard/courses/page.tsx', 'utf8')
assert.match(route, /from\('courses'\)\.insert\(\{ \.\.\.parsed\.value, owner_id: user\.id \}\)/)
assert.match(route, /\.eq\('owner_id', user\.id\)\.select\(\)\.single\(\)/)
assert.match(route, /export async function PATCH/)
assert.match(route, /createClient\(\)/)
assert.match(page, /method: editing \? 'PATCH' : 'POST'/)
assert.match(page, /Save draft/)
console.log('course creation checks passed')
