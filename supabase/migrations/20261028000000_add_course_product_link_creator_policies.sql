alter table public.course_product_links enable row level security;

drop policy if exists course_product_links_creator_manage on public.course_product_links;
create policy course_product_links_creator_manage on public.course_product_links
for all to authenticated
using (
  exists (select 1 from public.courses c where c.id = course_id and c.owner_id = (select auth.uid()))
  and exists (select 1 from public.products p join public.stores s on s.id = p.store_id where p.id = product_id and s.user_id = (select auth.uid()))
)
with check (
  exists (select 1 from public.courses c where c.id = course_id and c.owner_id = (select auth.uid()) and c.status = 'published')
  and exists (select 1 from public.products p join public.stores s on s.id = p.store_id where p.id = product_id and s.user_id = (select auth.uid()) and p.status = 'published')
);

revoke insert, update, delete on public.course_product_links from anon;
grant insert, update, delete on public.course_product_links to authenticated;
