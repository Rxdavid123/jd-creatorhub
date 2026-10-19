create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete restrict,
  customer_name text,
  customer_email text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'fulfilled', 'cancelled')),
  currency text not null check (char_length(currency) between 3 and 3),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity integer not null check (quantity > 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  created_at timestamptz not null default now()
);

create index if not exists orders_store_id_created_at_idx on public.orders(store_id, created_at desc);
create index if not exists orders_store_id_status_idx on public.orders(store_id, status);
create index if not exists order_items_order_id_idx on public.order_items(order_id);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

grant select, update on public.orders to authenticated;
grant select on public.order_items to authenticated;

drop policy if exists orders_owner_select on public.orders;
drop policy if exists orders_owner_update on public.orders;
drop policy if exists order_items_owner_select on public.order_items;

create policy orders_owner_select on public.orders
for select to authenticated
using (exists (select 1 from public.stores s where s.id = orders.store_id and s.user_id = (select auth.uid())));

create policy orders_owner_update on public.orders
for update to authenticated
using (exists (select 1 from public.stores s where s.id = orders.store_id and s.user_id = (select auth.uid())))
with check (exists (select 1 from public.stores s where s.id = orders.store_id and s.user_id = (select auth.uid())));

create policy order_items_owner_select on public.order_items
for select to authenticated
using (exists (select 1 from public.orders o join public.stores s on s.id = o.store_id where o.id = order_items.order_id and s.user_id = (select auth.uid())));

-- Order creation is intentionally unavailable in this phase. Do not grant INSERT to client roles.
-- Payment evidence and public checkout are intentionally out of scope.

create or replace function public.set_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders
for each row execute function public.set_orders_updated_at();

revoke all on function public.set_orders_updated_at() from public;
revoke all on function public.set_orders_updated_at() from anon, authenticated;

-- The dashboard should restrict edits to status; immutable order snapshots remain server-owned.
