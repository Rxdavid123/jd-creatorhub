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
  local_start := p_starts_at at time zone s.timezone;
  local_end := (p_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone;
  if p_starts_at < now() + make_interval(mins => s.min_notice_minutes) or p_starts_at > now() + make_interval(days => s.max_advance_days) then raise exception 'outside_booking_window'; end if;
  if not exists (
    select 1 from public.booking_availability a
    where a.service_id = s.id and a.weekday = extract(dow from local_start)::smallint and a.enabled
      and a.start_time <= local_start::time and a.end_time >= local_end::time
      and mod(extract(epoch from (local_start::time - a.start_time))::integer / 60, s.booking_interval_minutes) = 0
  ) then raise exception 'outside_availability'; end if;
  if exists(select 1 from public.booking_blocked_dates where service_id = s.id and blocked_date = local_start::date) then raise exception 'blocked_date'; end if;
  if exists(select 1 from public.booking_time_blocks where service_id = s.id and starts_at < p_starts_at + make_interval(mins => s.duration_minutes) and ends_at > p_starts_at) then raise exception 'blocked_time'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.id::text || p_starts_at::text, 0));
  if exists(
    select 1 from public.bookings x where x.service_id = s.id and x.status in ('pending','confirmed')
      and x.starts_at < p_starts_at + make_interval(mins => s.duration_minutes + s.buffer_minutes)
      and x.ends_at + make_interval(mins => s.buffer_minutes) > p_starts_at
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

commit;
