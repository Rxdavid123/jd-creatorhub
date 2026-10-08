create table if not exists public.product_files (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null,
  file_size bigint not null check (file_size > 0),
  created_at timestamptz not null default now()
);

alter table public.product_files enable row level security;

grant select, insert, update, delete on public.product_files to authenticated;

drop policy if exists product_files_owner_select on public.product_files;
drop policy if exists product_files_owner_insert on public.product_files;
drop policy if exists product_files_owner_update on public.product_files;
drop policy if exists product_files_owner_delete on public.product_files;

create policy product_files_owner_select on public.product_files
for select to authenticated
using (
  exists (
    select 1
    from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = product_files.product_id
      and s.user_id = (select auth.uid())
  )
);

create policy product_files_owner_insert on public.product_files
for insert to authenticated
with check (
  exists (
    select 1
    from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = product_files.product_id
      and s.user_id = (select auth.uid())
  )
);

create policy product_files_owner_update on public.product_files
for update to authenticated
using (
  exists (
    select 1
    from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = product_files.product_id
      and s.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = product_files.product_id
      and s.user_id = (select auth.uid())
  )
);

create policy product_files_owner_delete on public.product_files
for delete to authenticated
using (
  exists (
    select 1
    from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = product_files.product_id
      and s.user_id = (select auth.uid())
  )
);

-- Private product-file object paths must be: <auth.uid()>/<product_id>/<filename>.
-- Existing product-files storage policies already authorize the first path segment.
