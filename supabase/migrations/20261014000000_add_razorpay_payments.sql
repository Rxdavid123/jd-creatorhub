create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  provider text not null default 'razorpay' check (provider = 'razorpay'),
  provider_order_id text not null,
  provider_payment_id text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (char_length(currency) = 3),
  status text not null default 'created' check (status in ('created', 'authorized', 'captured', 'failed', 'cancelled')),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  captured_at timestamptz,
  constraint payments_provider_order_unique unique (provider, provider_order_id),
  constraint payments_provider_payment_unique unique (provider, provider_payment_id)
);

create index if not exists payments_order_id_idx on public.payments(order_id);
create index if not exists payments_status_idx on public.payments(status);
alter table public.payments enable row level security;
grant select on public.payments to authenticated;

drop policy if exists payments_owner_select on public.payments;
create policy payments_owner_select on public.payments
for select to authenticated
using (exists (select 1 from public.orders o join public.stores s on s.id = o.store_id where o.id = payments.order_id and s.user_id = (select auth.uid())));

create or replace function public.set_payments_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at before update on public.payments for each row execute function public.set_payments_updated_at();
revoke all on function public.set_payments_updated_at() from public, anon, authenticated;

create or replace function public.create_public_checkout_order(p_product_id uuid, p_quantity integer, p_customer_name text, p_customer_email text)
returns table(order_id uuid, amount_minor bigint, currency text, product_name text)
language plpgsql security definer set search_path = public
as $$
declare
  v_product record;
  v_order_id uuid;
  v_amount bigint;
  v_name text;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 100 then raise exception 'Invalid quantity'; end if;
  select p.id, p.store_id, p.name, p.price, p.currency into v_product
  from public.products p join public.stores s on s.id = p.store_id
  where p.id = p_product_id and p.status = 'published' and s.is_published = true;
  if not found or v_product.price is null or v_product.price <= 0 then raise exception 'Product unavailable'; end if;
  v_amount := round(v_product.price * 100) * p_quantity;
  if v_amount <= 0 then raise exception 'Invalid amount'; end if;
  insert into public.orders (store_id, customer_name, customer_email, status, currency, subtotal_minor, total_minor)
  values (v_product.store_id, nullif(left(trim(p_customer_name), 160), ''), nullif(left(trim(p_customer_email), 320), ''), 'pending', v_product.currency, v_amount, v_amount)
  returning id into v_order_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor)
  values (v_order_id, v_product.id, v_product.name, round(v_product.price * 100), p_quantity, v_amount);
  return query select v_order_id, v_amount, v_product.currency, v_product.name;
end;
$$;
revoke all on function public.create_public_checkout_order(uuid, integer, text, text) from public;
grant execute on function public.create_public_checkout_order(uuid, integer, text, text) to anon, authenticated;

create or replace function public.mark_order_paid(p_order_id uuid, p_provider_payment_id text, p_provider_order_id text, p_amount_minor bigint, p_currency text)
returns boolean language plpgsql security definer set search_path = public
as $$
declare v_payment public.payments;
begin
  select * into v_payment from public.payments where provider = 'razorpay' and provider_order_id = p_provider_order_id for update;
  if not found or v_payment.order_id <> p_order_id or v_payment.amount_minor <> p_amount_minor or v_payment.currency <> p_currency then return false; end if;
  insert into public.payments (order_id, provider, provider_order_id, provider_payment_id, amount_minor, currency, status, captured_at)
  values (p_order_id, 'razorpay', p_provider_order_id, p_provider_payment_id, p_amount_minor, p_currency, 'captured', now())
  on conflict (provider, provider_order_id) do update set provider_payment_id = excluded.provider_payment_id, status = 'captured', captured_at = coalesce(public.payments.captured_at, excluded.captured_at), updated_at = now();
  update public.orders set status = 'processing', updated_at = now() where id = p_order_id and status <> 'cancelled';
  return true;
end;
$$;
revoke all on function public.mark_order_paid(uuid, text, text, bigint, text) from public, anon, authenticated;

create or replace function public.record_payment_created(p_order_id uuid, p_provider_order_id text, p_amount_minor bigint, p_currency text)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.orders where id = p_order_id and total_minor = p_amount_minor and currency = p_currency) then return false; end if;
  insert into public.payments (order_id, provider, provider_order_id, amount_minor, currency)
  values (p_order_id, 'razorpay', p_provider_order_id, p_amount_minor, p_currency)
  on conflict (provider, provider_order_id) do nothing;
  return true;
end;
$$;
revoke all on function public.record_payment_created(uuid, text, bigint, text) from public, anon, authenticated;

create or replace function public.record_payment_failed(p_provider_order_id text, p_provider_payment_id text, p_reason text)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  update public.payments set status = 'failed', provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id), failure_reason = left(p_reason, 500), updated_at = now() where provider = 'razorpay' and provider_order_id = p_provider_order_id and status <> 'captured';
  return found;
end;
$$;
revoke all on function public.record_payment_failed(text, text, text) from public, anon, authenticated;

create table if not exists public.payment_webhook_events (
  event_id text primary key,
  provider text not null default 'razorpay',
  received_at timestamptz not null default now()
);
alter table public.payment_webhook_events enable row level security;
revoke all on public.payment_webhook_events from public, anon, authenticated;
