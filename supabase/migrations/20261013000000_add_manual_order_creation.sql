create or replace function public.create_manual_order(
  p_customer_name text,
  p_customer_email text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid;
  v_order_id uuid;
  v_currency text;
  v_total bigint;
  v_item jsonb;
  v_product record;
  v_quantity integer;
  v_unit_price bigint;
  v_line_total bigint;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select id into v_store_id from public.stores where user_id = v_user_id limit 1;
  if v_store_id is null then raise exception 'Store not found'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then raise exception 'Invalid items'; end if;

  create temporary table _manual_order_items (
    product_id uuid, product_name text, unit_price_minor bigint, quantity integer, line_total_minor bigint, currency text
  ) on commit drop;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity < 1 or v_quantity > 100 then raise exception 'Invalid quantity'; end if;
    select id, name, price, currency into v_product from public.products where id = (v_item->>'productId')::uuid and store_id = v_store_id and status = 'active';
    if not found then raise exception 'Product unavailable'; end if;
    v_unit_price := round(v_product.price * 100);
    v_line_total := v_unit_price * v_quantity;
    if v_currency is null then v_currency := v_product.currency; elsif v_currency <> v_product.currency then raise exception 'Currency mismatch'; end if;
    insert into _manual_order_items values (v_product.id, v_product.name, v_unit_price, v_quantity, v_line_total, v_product.currency);
  end loop;

  select coalesce(sum(line_total_minor), 0) into v_total from _manual_order_items;
  insert into public.orders (store_id, customer_name, customer_email, status, currency, subtotal_minor, total_minor)
  values (v_store_id, nullif(left(trim(p_customer_name), 160), ''), nullif(left(trim(p_customer_email), 320), ''), 'pending', v_currency, v_total, v_total)
  returning id into v_order_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor)
  select v_order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor from _manual_order_items;
  return v_order_id;
end;
$$;

revoke all on function public.create_manual_order(text, text, jsonb) from public, anon;
grant execute on function public.create_manual_order(text, text, jsonb) to authenticated;
