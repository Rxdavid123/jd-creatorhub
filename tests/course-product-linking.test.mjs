import assert from 'node:assert/strict'
import fs from 'node:fs'
const route = fs.readFileSync('app/api/courses/links/route.ts', 'utf8')
const productRoute = fs.readFileSync('app/api/products/owned/route.ts', 'utf8')
const migration = fs.readFileSync('supabase/migrations/20261028000000_add_course_product_link_creator_policies.sql', 'utf8')
for (const value of ['currentUser()', 'owner_id', "status !== 'published'", 'price_minor', 'product.currency', "23505"]) assert.ok(route.includes(value), `route missing ${value}`)
for (const value of ['stores!inner(user_id)', 'currentUser()', 'Authentication required']) assert.ok(productRoute.includes(value), `product route missing ${value}`)
for (const value of ['for all to authenticated', 'auth.uid()', "c.status = 'published'", "p.status = 'published'", 'grant insert, update, delete']) assert.ok(migration.includes(value), `migration missing ${value}`)
console.log('course product linking checks passed')
