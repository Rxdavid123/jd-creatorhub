begin;

alter table public.booking_services
  add column if not exists booking_interval_minutes integer not null default 30;
alter table public.booking_services
  drop constraint if exists booking_services_booking_interval_minutes_check;
alter table public.booking_services
  add constraint booking_services_booking_interval_minutes_check
  check (booking_interval_minutes between 5 and 240);

alter table public.booking_availability
  drop constraint if exists booking_availability_service_id_weekday_key;
create index if not exists booking_availability_service_weekday_start_idx
  on public.booking_availability(service_id, weekday, start_time);

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
  if p_customer_name is null or length(trim(p_customer_name)) = 0 or trim(p_customer_email) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_customer'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(s.id::text, 0));
  local_start := p_starts_at at time zone s.timezone;
  local_end := (p_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone;
  if p_starts_at < now() + make_interval(mins => s.min_notice_minutes) or p_starts_at > now() + make_interval(days => s.max_advance_days) then raise exception 'outside_booking_window'; end if;
  if not exists (
    select 1 from public.booking_availability a
    where a.service_id = s.id and a.weekday = extract(dow from local_start)::smallint and a.enabled
      and a.start_time <= local_start::time and a.end_time >= local_end::time
      and mod(floor(extract(epoch from (local_start::time - a.start_time)) / 60)::integer, s.booking_interval_minutes) = 0
  ) then raise exception 'outside_availability'; end if;
  if exists(select 1 from public.booking_blocked_dates where service_id = s.id and blocked_date = local_start::date) then raise exception 'blocked_date'; end if;
  if exists(select 1 from public.booking_time_blocks where service_id = s.id and starts_at < p_starts_at + make_interval(mins => s.duration_minutes) and ends_at > p_starts_at) then raise exception 'blocked_time'; end if;
  if exists (
    select 1 from public.bookings x
    where x.service_id = s.id and x.status in ('pending','confirmed')
      and x.starts_at < p_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
      and x.ends_at + make_interval(mins => s.buffer_minutes) > p_starts_at
  ) or exists (
    select 1 from public.booking_change_requests r
    join public.bookings x on x.id = r.booking_id
    where x.service_id = s.id and r.status = 'pending' and r.request_type = 'reschedule'
      and r.requested_starts_at < p_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
      and r.requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes) > p_starts_at
  ) then raise exception 'slot_taken'; end if;

  insert into public.bookings(service_id,creator_id,customer_name,customer_email,customer_phone,customer_note,starts_at,ends_at,timezone,status,payment_status,public_token)
  values(s.id,s.creator_id,trim(p_customer_name),lower(trim(p_customer_email)),nullif(trim(p_customer_phone),''),nullif(trim(p_customer_note),''),p_starts_at,p_starts_at+make_interval(mins=>s.duration_minutes),s.timezone,case when s.price_minor=0 then 'confirmed' else 'pending' end,case when s.price_minor=0 then 'not_required' else 'pending' end,encode(extensions.gen_random_bytes(24),'hex'))
  returning * into b;
  insert into public.booking_notifications(booking_id,notification_type,status) values(b.id,'confirmation','not_configured');
  return b;
exception when unique_violation then raise exception 'slot_taken';
end;
$$;
revoke all on function public.create_public_booking(uuid,timestamptz,text,text,text,text) from public;
grant execute on function public.create_public_booking(uuid,timestamptz,text,text,text,text) to anon, authenticated;

create or replace function public.submit_booking_change_request(p_token text, p_request_type text, p_reason text, p_requested_starts_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
  s public.booking_services;
  local_start timestamp;
  local_end timestamp;
  req public.booking_change_requests;
begin
  if p_request_type not in ('cancellation','reschedule') or p_reason is null or char_length(trim(p_reason)) not between 1 and 1000 then raise exception 'invalid_request'; end if;
  if (p_request_type = 'reschedule') <> (p_requested_starts_at is not null) then raise exception 'invalid_request'; end if;
  select * into b from public.bookings where public.bookings.public_token = p_token for update;
  if not found then raise exception 'booking_not_found'; end if;
  if b.status not in ('pending','confirmed') then raise exception 'booking_not_active'; end if;
  if exists(select 1 from public.booking_change_requests r where r.booking_id = b.id and r.status = 'pending') then raise exception 'request_pending'; end if;
  if p_request_type = 'reschedule' then
    select * into s from public.booking_services where id = b.service_id;
    if not found then raise exception 'service_unavailable'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(s.id::text, 0));
    if p_requested_starts_at <= now() + make_interval(mins => s.min_notice_minutes) or p_requested_starts_at > now() + make_interval(days => s.max_advance_days) then raise exception 'outside_booking_window'; end if;
    local_start := p_requested_starts_at at time zone s.timezone;
    local_end := (p_requested_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone;
    if not exists (
      select 1 from public.booking_availability a
      where a.service_id = s.id and a.weekday = extract(dow from local_start)::smallint and a.enabled
        and a.start_time <= local_start::time and a.end_time >= local_end::time
        and mod(floor(extract(epoch from (local_start::time - a.start_time)) / 60)::integer, s.booking_interval_minutes) = 0
    ) then raise exception 'outside_availability'; end if;
    if exists(select 1 from public.booking_blocked_dates where service_id = s.id and blocked_date = local_start::date) then raise exception 'blocked_date'; end if;
    if exists(select 1 from public.booking_time_blocks where service_id = s.id and starts_at < p_requested_starts_at + make_interval(mins => s.duration_minutes) and ends_at > p_requested_starts_at) then raise exception 'blocked_time'; end if;
    if exists (
      select 1 from public.bookings x
      where x.service_id = s.id and x.id <> b.id and x.status in ('pending','confirmed')
        and x.starts_at < p_requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
        and x.ends_at + make_interval(mins => s.buffer_minutes) > p_requested_starts_at
    ) or exists (
      select 1 from public.booking_change_requests r
      join public.bookings x on x.id = r.booking_id
      where x.service_id = s.id and r.status = 'pending' and r.request_type = 'reschedule'
        and r.booking_id <> b.id
        and r.requested_starts_at < p_requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
        and r.requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes) > p_requested_starts_at
    ) then raise exception 'slot_taken'; end if;
  end if;
  insert into public.booking_change_requests(booking_id, request_type, reason, requested_starts_at)
    values (b.id, p_request_type, trim(p_reason), p_requested_starts_at) returning * into req;
  insert into public.booking_notifications(booking_id, change_request_id, notification_type, status)
    values (b.id, req.id, 'change_request_submitted', 'pending');
  return jsonb_build_object('request_id', req.id, 'booking_id', b.id, 'creator_id', b.creator_id, 'customer_email', b.customer_email, 'customer_name', b.customer_name, 'starts_at', b.starts_at, 'timezone', b.timezone, 'request_type', req.request_type, 'requested_starts_at', req.requested_starts_at, 'status', req.status);
exception when unique_violation then raise exception 'request_pending';
end;
$$;
revoke all on function public.submit_booking_change_request(text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.submit_booking_change_request(text,text,text,timestamptz) to service_role;

create or replace function public.decide_booking_change_request(p_request_id uuid, p_creator_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.booking_change_requests;
  b public.bookings;
  s public.booking_services;
  local_start timestamp;
  local_end timestamp;
begin
  if p_decision not in ('approved','rejected') then raise exception 'invalid_decision'; end if;
  select * into r from public.booking_change_requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  select * into b from public.bookings where id = r.booking_id for update;
  if b.creator_id <> p_creator_id then raise exception 'not_owner'; end if;
  if r.status <> 'pending' then raise exception 'request_not_pending'; end if;
  if b.status not in ('pending','confirmed') then raise exception 'booking_not_active'; end if;
  if p_decision = 'approved' then
    if r.request_type = 'cancellation' then
      update public.bookings set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = b.id;
    else
      select * into s from public.booking_services where id = b.service_id;
      if not found then raise exception 'service_unavailable'; end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(s.id::text, 0));
      if r.requested_starts_at <= now() + make_interval(mins => s.min_notice_minutes) or r.requested_starts_at > now() + make_interval(days => s.max_advance_days) then raise exception 'outside_booking_window'; end if;
      local_start := r.requested_starts_at at time zone s.timezone;
      local_end := (r.requested_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone;
      if not exists (
        select 1 from public.booking_availability a
        where a.service_id = s.id and a.weekday = extract(dow from local_start)::smallint and a.enabled
          and a.start_time <= local_start::time and a.end_time >= local_end::time
          and mod(floor(extract(epoch from (local_start::time - a.start_time)) / 60)::integer, s.booking_interval_minutes) = 0
      ) then raise exception 'outside_availability'; end if;
      if exists(select 1 from public.booking_blocked_dates where service_id = s.id and blocked_date = local_start::date) then raise exception 'blocked_date'; end if;
      if exists(select 1 from public.booking_time_blocks where service_id = s.id and starts_at < r.requested_starts_at + make_interval(mins => s.duration_minutes) and ends_at > r.requested_starts_at) then raise exception 'blocked_time'; end if;
      if exists (
        select 1 from public.bookings x
        where x.service_id = s.id and x.id <> b.id and x.status in ('pending','confirmed')
          and x.starts_at < r.requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
          and x.ends_at + make_interval(mins => s.buffer_minutes) > r.requested_starts_at
      ) or exists (
        select 1 from public.booking_change_requests other_request
        join public.bookings x on x.id = other_request.booking_id
        where x.service_id = s.id and other_request.status = 'pending' and other_request.request_type = 'reschedule'
          and other_request.id <> r.id
          and other_request.requested_starts_at < r.requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
          and other_request.requested_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes) > r.requested_starts_at
      ) then raise exception 'slot_taken'; end if;
      update public.bookings set starts_at = r.requested_starts_at, ends_at = r.requested_starts_at + make_interval(mins => s.duration_minutes), updated_at = now() where id = b.id;
    end if;
  end if;
  update public.booking_change_requests set status = p_decision, decided_at = now() where id = r.id;
  insert into public.booking_notifications(booking_id, change_request_id, notification_type, status)
    values (b.id, r.id, 'change_request_decision', 'pending');
  return jsonb_build_object('booking_id', b.id, 'request_id', r.id, 'request_type', r.request_type, 'status', p_decision, 'creator_id', b.creator_id, 'customer_email', b.customer_email, 'customer_name', b.customer_name, 'starts_at', case when p_decision = 'approved' and r.request_type = 'reschedule' then r.requested_starts_at else b.starts_at end, 'timezone', b.timezone);
end;
$$;
revoke all on function public.decide_booking_change_request(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.decide_booking_change_request(uuid,uuid,text) to service_role;

commit;
