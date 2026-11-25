begin;

alter table public.bookings
  add column if not exists payment_expires_at timestamptz;

alter table public.booking_services
  drop constraint if exists booking_services_currency_check,
  add constraint booking_services_currency_check
    check (currency in ('INR', 'USD', 'EUR', 'GBP', 'AED', 'AUD', 'CAD', 'SGD'));

alter table public.bookings
  add column if not exists price_minor bigint not null default 0,
  add column if not exists currency text not null default 'INR';

update public.bookings b
set price_minor = s.price_minor, currency = s.currency
from public.booking_services s
where s.id = b.service_id;

alter table public.bookings
  add constraint bookings_price_minor_check check (price_minor >= 0),
  add constraint bookings_currency_check
    check (currency in ('INR', 'USD', 'EUR', 'GBP', 'AED', 'AUD', 'CAD', 'SGD'));

alter table public.bookings
  drop constraint if exists bookings_status_check,
  add constraint bookings_status_check
    check (status in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'expired')),
  drop constraint if exists bookings_payment_status_check,
  add constraint bookings_payment_status_check
    check (payment_status in ('not_required', 'pending', 'captured', 'failed', 'refunded', 'expired'));

create table if not exists public.booking_payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  receipt text not null unique,
  idempotency_key text not null unique,
  provider text not null default 'razorpay' check (provider = 'razorpay'),
  provider_order_id text,
  provider_payment_id text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'creating' check (status in ('creating', 'created', 'captured', 'failed', 'expired')),
  failure_reason text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  captured_at timestamptz,
  constraint booking_payments_attempt_unique unique (booking_id, attempt_number),
  constraint booking_payments_provider_order_unique unique (provider, provider_order_id),
  constraint booking_payments_provider_payment_unique unique (provider, provider_payment_id)
);

create index if not exists booking_payments_booking_idx
  on public.booking_payments (booking_id, attempt_number desc);
create index if not exists booking_payments_expiry_idx
  on public.booking_payments (expires_at)
  where status in ('creating', 'created');

grant select, insert, delete on public.payment_webhook_events to service_role;

alter table public.booking_payments enable row level security;
revoke all on public.booking_payments from public, anon, authenticated;
grant select on public.booking_payments to authenticated;
grant select, insert, update, delete on public.booking_payments to service_role;
create policy booking_payments_creator_read on public.booking_payments
  for select to authenticated
  using (
    exists (
      select 1 from public.bookings b
      where b.id = booking_payments.booking_id
        and b.creator_id = (select auth.uid())
    )
  );

revoke update on public.bookings from authenticated;
grant update (status, cancelled_at, internal_note) on public.bookings to authenticated;
drop policy if exists bookings_owner_update on public.bookings;
create policy bookings_owner_update on public.bookings
  for update to authenticated
  using (creator_id = (select auth.uid()))
  with check (
    creator_id = (select auth.uid())
    and not (price_minor > 0 and payment_status <> 'captured' and status = 'confirmed')
  );

create or replace function public.expire_booking_payment_holds(p_service_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_count integer;
begin
  if p_service_id is null then raise exception 'service_id_required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_service_id::text, 0));

  update public.booking_payments bp
  set status = 'expired', failure_reason = coalesce(bp.failure_reason, 'payment_expired'), updated_at = now()
  from public.bookings b
  where bp.booking_id = b.id
    and b.service_id = p_service_id
    and b.status = 'pending'
    and b.payment_status in ('pending', 'failed')
    and b.payment_expires_at <= now()
    and bp.status in ('creating', 'created');

  update public.bookings
  set status = 'expired', payment_status = 'expired', updated_at = now()
  where service_id = p_service_id
    and status = 'pending'
    and payment_status in ('pending', 'failed')
    and payment_expires_at <= now();
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

create or replace function public.create_public_booking(
  p_service_id uuid,
  p_starts_at timestamptz,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text default null,
  p_customer_note text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.booking_services;
  b public.bookings;
  local_start timestamp;
  local_end timestamp;
begin
  select * into s from public.booking_services where id = p_service_id and status = 'published';
  if not found then raise exception 'service_unavailable'; end if;
  if p_customer_name is null or char_length(trim(p_customer_name)) not between 1 and 160
    or trim(p_customer_email) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_customer';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(s.id::text, 0));
  perform public.expire_booking_payment_holds(s.id);

  local_start := p_starts_at at time zone s.timezone;
  local_end := (p_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone;
  if p_starts_at < now() + make_interval(mins => s.min_notice_minutes)
    or p_starts_at > now() + make_interval(days => s.max_advance_days) then
    raise exception 'outside_booking_window';
  end if;
  if not exists (
    select 1 from public.booking_availability a
    where a.service_id = s.id
      and a.weekday = extract(dow from local_start)::smallint
      and a.enabled
      and a.start_time <= local_start::time
      and a.end_time >= local_end::time
      and mod(
        floor(extract(epoch from (local_start::time - a.start_time)) / 60)::integer,
        s.booking_interval_minutes
      ) = 0
  ) then raise exception 'outside_availability'; end if;
  if exists (
    select 1 from public.booking_blocked_dates d
    where d.service_id = s.id and d.blocked_date = local_start::date
  ) then raise exception 'blocked_date'; end if;
  if exists (
    select 1 from public.booking_time_blocks tb
    where tb.service_id = s.id
      and tb.starts_at < p_starts_at + make_interval(mins => s.duration_minutes)
      and tb.ends_at > p_starts_at
  ) then raise exception 'blocked_time'; end if;
  if exists (
    select 1 from public.bookings x
    where x.service_id = s.id
      and x.status in ('pending', 'confirmed')
      and (x.status = 'confirmed' or x.payment_status <> 'pending' or x.payment_expires_at is null or x.payment_expires_at > now())
      and x.starts_at < p_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
      and x.ends_at + make_interval(mins => s.buffer_minutes) > p_starts_at
  ) or exists (
    select 1 from public.booking_change_requests r
    join public.bookings x on x.id = r.booking_id
    where x.service_id = s.id
      and r.status = 'pending'
      and r.request_type = 'reschedule'
      and r.requested_starts_at < p_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
      and r.requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes) > p_starts_at
  ) then raise exception 'slot_taken'; end if;

  insert into public.bookings (
    service_id, creator_id, customer_name, customer_email, customer_phone, customer_note,
    starts_at, ends_at, timezone, status, payment_status, payment_expires_at, price_minor, currency, public_token
  ) values (
    s.id, s.creator_id, trim(p_customer_name), lower(trim(p_customer_email)),
    nullif(trim(p_customer_phone), ''), nullif(trim(p_customer_note), ''),
    p_starts_at, p_starts_at + make_interval(mins => s.duration_minutes), s.timezone,
    case when s.price_minor = 0 then 'confirmed' else 'pending' end,
    case when s.price_minor = 0 then 'not_required' else 'pending' end,
    case when s.price_minor = 0 then null else now() + interval '10 minutes' end,
    s.price_minor, s.currency,
    encode(extensions.gen_random_bytes(24), 'hex')
  ) returning * into b;

  if s.price_minor = 0 then
    insert into public.booking_notifications (booking_id, notification_type, status)
    values (b.id, 'confirmation', 'not_configured');
  end if;
  return b;
exception when unique_violation then
  raise exception 'slot_taken';
end;
$$;

create or replace function public.prepare_booking_payment_attempt(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  service_id_value uuid;
  b public.bookings;
  s public.booking_services;
  attempt public.booking_payments;
  local_start timestamp;
  local_end timestamp;
  next_attempt integer;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{48}$' then raise exception 'booking_not_found'; end if;
  select service_id into service_id_value from public.bookings where public_token = p_token;
  if not found then raise exception 'booking_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(service_id_value::text, 0));
  perform public.expire_booking_payment_holds(service_id_value);
  select * into b from public.bookings where public_token = p_token for update;
  select * into s from public.booking_services where id = b.service_id;
  if s.status <> 'published' then raise exception 'service_unavailable'; end if;

  if b.status = 'expired' or b.payment_expires_at is null or b.payment_expires_at <= now() then
    raise exception 'payment_expired';
  end if;
  if b.status <> 'pending' or b.payment_status not in ('pending', 'failed') then
    raise exception 'booking_not_awaiting_payment';
  end if;
  if b.price_minor <= 0 then raise exception 'payment_not_required'; end if;

  local_start := b.starts_at at time zone s.timezone;
  local_end := b.ends_at at time zone s.timezone;
  if b.starts_at < now() + make_interval(mins => s.min_notice_minutes)
    or b.starts_at > now() + make_interval(days => s.max_advance_days) then
    raise exception 'outside_booking_window';
  end if;
  if not exists (
    select 1 from public.booking_availability a
    where a.service_id = s.id and a.weekday = extract(dow from local_start)::smallint and a.enabled
      and a.start_time <= local_start::time and a.end_time >= local_end::time
      and mod(floor(extract(epoch from (local_start::time - a.start_time)) / 60)::integer, s.booking_interval_minutes) = 0
  ) then raise exception 'outside_availability'; end if;
  if exists (select 1 from public.booking_blocked_dates d where d.service_id = s.id and d.blocked_date = local_start::date) then raise exception 'blocked_date'; end if;
  if exists (
    select 1 from public.booking_time_blocks tb
    where tb.service_id = s.id and tb.starts_at < b.ends_at and tb.ends_at > b.starts_at
  ) then raise exception 'blocked_time'; end if;
  if exists (
    select 1 from public.bookings x
    where x.service_id = s.id and x.id <> b.id and x.status in ('pending', 'confirmed')
      and (x.status = 'confirmed' or x.payment_status <> 'pending' or x.payment_expires_at is null or x.payment_expires_at > now())
      and x.starts_at < b.ends_at + make_interval(mins => s.buffer_minutes)
      and x.ends_at + make_interval(mins => s.buffer_minutes) > b.starts_at
  ) or exists (
    select 1 from public.booking_change_requests r
    join public.bookings x on x.id = r.booking_id
    where x.service_id = s.id and r.status = 'pending' and r.request_type = 'reschedule'
      and r.requested_starts_at < b.ends_at + make_interval(mins => s.buffer_minutes)
      and r.requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes) > b.starts_at
  ) then raise exception 'slot_taken'; end if;

  select * into attempt from public.booking_payments
  where booking_id = b.id order by attempt_number desc limit 1 for update;
  if found and attempt.status = 'created' and attempt.provider_order_id is not null and attempt.expires_at > now() then
    return jsonb_build_object(
      'attempt_id', attempt.id, 'should_create', false, 'provider_order_id', attempt.provider_order_id,
      'amount_minor', attempt.amount_minor, 'currency', attempt.currency, 'receipt', attempt.receipt,
      'expires_at', attempt.expires_at
    );
  end if;
  if found and attempt.status = 'creating' and attempt.created_at > now() - interval '2 minutes' then
    return jsonb_build_object('attempt_id', attempt.id, 'should_create', false, 'creating', true, 'expires_at', attempt.expires_at);
  end if;

  select coalesce(max(attempt_number), 0) + 1 into next_attempt
  from public.booking_payments where booking_id = b.id;
  insert into public.booking_payments (
    booking_id, attempt_number, receipt, idempotency_key, amount_minor, currency, expires_at
  ) values (
    b.id, next_attempt, 'bp_' || replace(gen_random_uuid()::text, '-', ''),
    encode(extensions.gen_random_bytes(24), 'hex'), b.price_minor, b.currency, b.payment_expires_at
  ) returning * into attempt;
  update public.bookings set payment_status = 'pending', updated_at = now() where id = b.id;
  return jsonb_build_object(
    'attempt_id', attempt.id, 'should_create', true, 'amount_minor', attempt.amount_minor,
    'currency', attempt.currency, 'receipt', attempt.receipt, 'expires_at', attempt.expires_at
  );
end;
$$;

create or replace function public.record_booking_payment_order(p_attempt_id uuid, p_provider_order_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking_id_value uuid;
  service_id_value uuid;
  attempt public.booking_payments;
  b public.bookings;
begin
  if p_provider_order_id is null or p_provider_order_id !~ '^order_[A-Za-z0-9]+$' then return false; end if;
  select bp.booking_id, b.service_id into booking_id_value, service_id_value
  from public.booking_payments bp join public.bookings b on b.id = bp.booking_id
  where bp.id = p_attempt_id;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(service_id_value::text, 0));
  select * into b from public.bookings where id = booking_id_value for update;
  select * into attempt from public.booking_payments where id = p_attempt_id for update;
  if attempt.provider_order_id = p_provider_order_id and attempt.status = 'created' then return true; end if;
  if attempt.status <> 'creating' or b.status <> 'pending' or b.payment_expires_at <= now() then
    update public.booking_payments set status = 'expired', failure_reason = 'payment_expired', updated_at = now()
      where id = p_attempt_id and status = 'creating';
    return false;
  end if;
  update public.booking_payments
  set provider_order_id = p_provider_order_id, status = 'created', updated_at = now()
  where id = p_attempt_id;
  return true;
exception when unique_violation then
  return false;
end;
$$;

create or replace function public.fail_booking_payment_order_creation(p_attempt_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  service_id_value uuid;
  booking_id_value uuid;
  failed_count integer;
begin
  select b.service_id, b.id into service_id_value, booking_id_value
  from public.booking_payments bp join public.bookings b on b.id = bp.booking_id
  where bp.id = p_attempt_id;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(service_id_value::text, 0));
  update public.booking_payments
  set status = 'failed', failure_reason = left(coalesce(p_reason, 'payment_order_creation_failed'), 500), updated_at = now()
  where id = p_attempt_id and status = 'creating';
  get diagnostics failed_count = row_count;
  if failed_count > 0 and not exists (
    select 1 from public.booking_payments later
    where later.booking_id = booking_id_value and later.attempt_number > (
      select current_attempt.attempt_number from public.booking_payments current_attempt where current_attempt.id = p_attempt_id
    ) and later.status in ('creating', 'created', 'captured')
  ) then
    update public.bookings set payment_status = 'failed', updated_at = now()
    where id = booking_id_value and status = 'pending' and payment_expires_at > now();
  end if;
  return failed_count > 0;
end;
$$;

create or replace function public.get_booking_payment_for_verification(p_token text, p_provider_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'attempt_id', bp.id, 'booking_id', b.id, 'amount_minor', bp.amount_minor,
    'currency', bp.currency, 'status', bp.status, 'expires_at', bp.expires_at,
    'booking_status', b.status, 'payment_status', b.payment_status
  ) into result
  from public.booking_payments bp
  join public.bookings b on b.id = bp.booking_id
  where b.public_token = p_token and bp.provider_order_id = p_provider_order_id;
  return result;
end;
$$;

create or replace function public.mark_booking_payment_failed(
  p_provider_order_id text,
  p_provider_payment_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt public.booking_payments;
  attempt_id_value uuid;
  b public.bookings;
  service_id_value uuid;
begin
  select bp.id, booking.service_id into attempt_id_value, service_id_value
  from public.booking_payments bp join public.bookings as booking on booking.id = bp.booking_id
  where bp.provider_order_id = p_provider_order_id;
  if not found then return null; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(service_id_value::text, 0));
  select * into attempt from public.booking_payments where id = attempt_id_value for update;
  select * into b from public.bookings where id = attempt.booking_id for update;
  if attempt.status = 'captured' then return jsonb_build_object('booking_id', b.id, 'status', 'captured'); end if;

  update public.booking_payments
  set status = 'failed', provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
      failure_reason = left(coalesce(p_reason, 'payment_failed'), 500), updated_at = now()
  where id = attempt.id;

  if b.status = 'pending' and b.payment_expires_at <= now() then
    perform public.expire_booking_payment_holds(b.service_id);
  elsif b.status = 'pending' and not exists (
    select 1 from public.booking_payments later
    where later.booking_id = b.id and later.attempt_number > attempt.attempt_number
      and later.status in ('creating', 'created', 'captured')
  ) then
    update public.bookings set payment_status = 'failed', updated_at = now() where id = b.id;
  end if;
  return jsonb_build_object('booking_id', b.id, 'status', 'failed');
exception when unique_violation then
  return null;
end;
$$;

create or replace function public.confirm_booking_payment(
  p_provider_order_id text,
  p_provider_payment_id text,
  p_amount_minor bigint,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt public.booking_payments;
  b public.bookings;
  s public.booking_services;
  service_id_value uuid;
  local_start timestamp;
  local_end timestamp;
  can_confirm boolean;
begin
  if p_provider_order_id is null or p_provider_payment_id is null
    or p_provider_order_id !~ '^order_[A-Za-z0-9]+$'
    or p_provider_payment_id !~ '^pay_[A-Za-z0-9]+$' then
    return jsonb_build_object('confirmed', false, 'reason', 'invalid_payment_reference');
  end if;
  select b.service_id into service_id_value
  from public.booking_payments bp join public.bookings b on b.id = bp.booking_id
  where bp.provider_order_id = p_provider_order_id;
  if not found then return jsonb_build_object('confirmed', false, 'reason', 'payment_not_found'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(service_id_value::text, 0));
  select booking.* into b from public.bookings as booking
    join public.booking_payments bp on bp.booking_id = booking.id
    where bp.provider_order_id = p_provider_order_id for update of booking;
  select * into attempt from public.booking_payments where provider_order_id = p_provider_order_id for update;

  if attempt.amount_minor <> p_amount_minor or attempt.currency <> p_currency then
    return jsonb_build_object('confirmed', false, 'reason', 'payment_amount_mismatch');
  end if;
  if attempt.status = 'captured' then
    return jsonb_build_object(
      'confirmed', b.status = 'confirmed' and b.payment_status = 'captured',
      'duplicate', true, 'booking_id', b.id, 'payment_status', b.payment_status
    );
  end if;

  select * into s from public.booking_services where id = b.service_id;
  if b.payment_status = 'captured' or b.status = 'confirmed' then
    update public.booking_payments
    set status = 'captured', provider_payment_id = p_provider_payment_id,
        captured_at = coalesce(captured_at, now()), failure_reason = 'additional_capture_requires_manual_review', updated_at = now()
    where id = attempt.id;
    return jsonb_build_object('confirmed', true, 'duplicate_capture', true, 'booking_id', b.id, 'payment_status', 'captured');
  end if;

  if b.status <> 'pending' or b.payment_expires_at is null or b.payment_expires_at <= now() then
    update public.booking_payments
    set status = 'captured', provider_payment_id = p_provider_payment_id,
        captured_at = coalesce(captured_at, now()), failure_reason = 'payment_captured_after_reservation_expiry', updated_at = now()
    where id = attempt.id;
    update public.bookings
    set status = case when status = 'pending' then 'expired' else status end,
        payment_status = 'captured', updated_at = now()
    where id = b.id;
    return jsonb_build_object('confirmed', false, 'reason', 'payment_captured_after_expiry', 'booking_id', b.id, 'payment_status', 'captured');
  end if;

  local_start := b.starts_at at time zone s.timezone;
  local_end := b.ends_at at time zone s.timezone;
  can_confirm := s.status = 'published'
    and b.starts_at >= now() + make_interval(mins => s.min_notice_minutes)
    and b.starts_at <= now() + make_interval(days => s.max_advance_days)
    and exists (
      select 1 from public.booking_availability a
      where a.service_id = s.id and a.weekday = extract(dow from local_start)::smallint and a.enabled
        and a.start_time <= local_start::time and a.end_time >= local_end::time
        and mod(floor(extract(epoch from (local_start::time - a.start_time)) / 60)::integer, s.booking_interval_minutes) = 0
    )
    and not exists (
      select 1 from public.booking_blocked_dates d where d.service_id = s.id and d.blocked_date = local_start::date
    )
    and not exists (
      select 1 from public.booking_time_blocks tb
      where tb.service_id = s.id and tb.starts_at < b.ends_at and tb.ends_at > b.starts_at
    )
    and not exists (
      select 1 from public.bookings x
      where x.service_id = s.id and x.id <> b.id and x.status in ('pending', 'confirmed')
        and (x.status = 'confirmed' or x.payment_status <> 'pending' or x.payment_expires_at is null or x.payment_expires_at > now())
        and x.starts_at < b.ends_at + make_interval(mins => s.buffer_minutes)
        and x.ends_at + make_interval(mins => s.buffer_minutes) > b.starts_at
    )
    and not exists (
      select 1 from public.booking_change_requests r
      join public.bookings x on x.id = r.booking_id
      where x.service_id = s.id and x.id <> b.id and r.status = 'pending'
        and r.request_type = 'reschedule'
        and r.requested_starts_at < b.ends_at + make_interval(mins => s.buffer_minutes)
        and r.requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes) > b.starts_at
    );

  if not can_confirm then
    update public.booking_payments
    set status = 'captured', provider_payment_id = p_provider_payment_id,
        captured_at = coalesce(captured_at, now()), failure_reason = 'payment_captured_but_slot_unavailable', updated_at = now()
    where id = attempt.id;
    update public.bookings set status = 'expired', payment_status = 'captured', updated_at = now() where id = b.id;
    return jsonb_build_object('confirmed', false, 'reason', 'payment_captured_but_slot_unavailable', 'booking_id', b.id, 'payment_status', 'captured');
  end if;

  update public.booking_payments
  set status = 'captured', provider_payment_id = p_provider_payment_id,
      captured_at = coalesce(captured_at, now()), failure_reason = null, updated_at = now()
  where id = attempt.id;
  update public.bookings
  set status = 'confirmed', payment_status = 'captured', updated_at = now()
  where id = b.id;
  insert into public.booking_notifications (booking_id, notification_type, status)
  values (b.id, 'confirmation', 'pending')
  on conflict (booking_id, notification_type) do nothing;
  return jsonb_build_object('confirmed', true, 'booking_id', b.id, 'payment_status', 'captured');
exception when unique_violation then
  return jsonb_build_object('confirmed', false, 'reason', 'payment_reference_already_used');
end;
$$;

revoke all on function public.expire_booking_payment_holds(uuid) from public, anon, authenticated;
revoke all on function public.create_public_booking(uuid, timestamptz, text, text, text, text) from public;
revoke all on function public.prepare_booking_payment_attempt(text) from public, anon, authenticated;
revoke all on function public.record_booking_payment_order(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_booking_payment_order_creation(uuid, text) from public, anon, authenticated;
revoke all on function public.get_booking_payment_for_verification(text, text) from public, anon, authenticated;
revoke all on function public.mark_booking_payment_failed(text, text, text) from public, anon, authenticated;
revoke all on function public.confirm_booking_payment(text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.expire_booking_payment_holds(uuid) to service_role;
grant execute on function public.create_public_booking(uuid, timestamptz, text, text, text, text) to anon, authenticated;
grant execute on function public.prepare_booking_payment_attempt(text) to service_role;
grant execute on function public.record_booking_payment_order(uuid, text) to service_role;
grant execute on function public.fail_booking_payment_order_creation(uuid, text) to service_role;
grant execute on function public.get_booking_payment_for_verification(text, text) to service_role;
grant execute on function public.mark_booking_payment_failed(text, text, text) to service_role;
grant execute on function public.confirm_booking_payment(text, text, bigint, text) to service_role;

commit;
