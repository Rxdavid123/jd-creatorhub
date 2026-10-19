-- Harden the live Razorpay RPCs without changing their signatures or return types.
-- Review and apply manually in Supabase SQL Editor.

create or replace function public.create_public_checkout_order(
  p_product_id uuid,
  p_quantity integer,
  p_customer_name text,
  p_customer_email text
)
returns table(order_id uuid, amount_minor bigint, currency text, product_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product record;
  v_order_id uuid;
  v_amount bigint;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 100 then
    raise exception 'Invalid quantity';
  end if;

  select p.id, p.store_id, p.name, p.price, p.currency
    into v_product
    from public.products as p
    join public.stores as s on s.id = p.store_id
   where p.id = p_product_id
     and p.status = 'published'
     and s.is_published = true;

  if not found or v_product.price is null or v_product.price <= 0 then
    raise exception 'Product unavailable';
  end if;

  v_amount := round(v_product.price * 100) * p_quantity;
  if v_amount <= 0 then
    raise exception 'Invalid amount';
  end if;

  insert into public.orders (
    store_id, customer_name, customer_email, status, currency, subtotal_minor, total_minor
  ) values (
    v_product.store_id,
    nullif(left(trim(p_customer_name), 160), ''),
    nullif(left(trim(p_customer_email), 320), ''),
    'pending',
    v_product.currency,
    v_amount,
    v_amount
  )
  returning id into v_order_id;

  insert into public.order_items (
    order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor
  ) values (
    v_order_id,
    v_product.id,
    v_product.name,
    round(v_product.price * 100),
    p_quantity,
    v_amount
  );

  return query
  select v_order_id, v_amount, v_product.currency, v_product.name;
end;
$$;

create or replace function public.mark_order_paid(
  p_order_id uuid,
  p_provider_payment_id text,
  p_provider_order_id text,
  p_amount_minor bigint,
  p_currency text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_order public.orders;
  v_updated integer;
begin
  if nullif(trim(p_provider_payment_id), '') is null
     or nullif(trim(p_provider_order_id), '') is null
     or p_amount_minor is null
     or p_amount_minor <= 0
     or p_currency is null
     or char_length(p_currency) <> 3 then
    return false;
  end if;

  select o.* into v_order
    from public.orders as o
   where o.id = p_order_id
   for update;

  if not found or v_order.status = 'cancelled' then
    return false;
  end if;

  select p.* into v_payment
    from public.payments as p
   where p.provider = 'razorpay'
     and p.provider_order_id = p_provider_order_id
   for update;

  if not found
     or v_payment.order_id <> p_order_id
     or v_payment.amount_minor <> p_amount_minor
     or v_payment.currency <> p_currency
     or v_payment.status = 'cancelled' then
    return false;
  end if;

  if v_payment.status = 'captured' then
    return v_payment.provider_payment_id = p_provider_payment_id;
  end if;

  if v_payment.provider_payment_id is not null
     and v_payment.provider_payment_id <> p_provider_payment_id then
    return false;
  end if;

  update public.payments
     set provider_payment_id = p_provider_payment_id,
         status = 'captured',
         captured_at = coalesce(captured_at, pg_catalog.now()),
         updated_at = pg_catalog.now()
   where id = v_payment.id;

  update public.orders
     set status = 'processing', updated_at = pg_catalog.now()
   where id = p_order_id
     and status <> 'cancelled';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.record_payment_created(
  p_order_id uuid,
  p_provider_order_id text,
  p_amount_minor bigint,
  p_currency text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
begin
  if nullif(trim(p_provider_order_id), '') is null
     or p_amount_minor is null
     or p_amount_minor <= 0
     or p_currency is null
     or char_length(p_currency) <> 3 then
    return false;
  end if;

  if not exists (
    select 1 from public.orders
     where id = p_order_id
       and total_minor = p_amount_minor
       and currency = p_currency
       and status <> 'cancelled'
  ) then
    return false;
  end if;

  select p.* into v_payment
    from public.payments as p
   where p.provider = 'razorpay'
     and p.provider_order_id = p_provider_order_id
   for update;

  if found then
    return v_payment.order_id = p_order_id
       and v_payment.amount_minor = p_amount_minor
       and v_payment.currency = p_currency;
  end if;

  insert into public.payments (
    order_id, provider, provider_order_id, amount_minor, currency
  ) values (
    p_order_id, 'razorpay', p_provider_order_id, p_amount_minor, p_currency
  );

  return true;
end;
$$;

create or replace function public.record_payment_failed(
  p_provider_order_id text,
  p_provider_payment_id text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(trim(p_provider_order_id), '') is null then
    return false;
  end if;

  update public.payments
     set status = 'failed',
         provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
         failure_reason = left(p_reason, 500),
         updated_at = pg_catalog.now()
   where provider = 'razorpay'
     and provider_order_id = p_provider_order_id
     and status not in ('captured', 'cancelled')
     and (
       p_provider_payment_id is null
       or provider_payment_id is null
       or provider_payment_id = p_provider_payment_id
     );

  return found;
end;
$$;

-- Keep public checkout available, but keep all payment mutation RPCs server-only.
revoke all on function public.create_public_checkout_order(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.create_public_checkout_order(uuid, integer, text, text) to anon, authenticated, service_role;

revoke all on function public.record_payment_created(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.record_payment_created(uuid, text, bigint, text) to service_role;

revoke all on function public.mark_order_paid(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.mark_order_paid(uuid, text, text, bigint, text) to service_role;

revoke all on function public.record_payment_failed(text, text, text) from public, anon, authenticated;
grant execute on function public.record_payment_failed(text, text, text) to service_role;
