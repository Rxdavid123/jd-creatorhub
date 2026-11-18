-- Fix the deployed RPC's email regex without changing the booking schema.
-- POSIX space classes avoid SQL string/regex escaping ambiguity.
create or replace function public.create_public_booking(p_service_id uuid, p_starts_at timestamptz, p_customer_name text, p_customer_email text, p_customer_phone text default null, p_customer_note text default null)
returns public.bookings language plpgsql security definer set search_path = public as $$
declare s public.booking_services; b public.bookings; local_start timestamp; local_end timestamp; day_number int; window_row public.booking_availability; blocked boolean;
begin
  select * into s from public.booking_services where id=p_service_id and status='published'; if not found then raise exception 'service_unavailable'; end if;
  if p_customer_name is null or length(trim(p_customer_name))=0 or trim(p_customer_email) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_customer'; end if;
  local_start := p_starts_at at time zone s.timezone; local_end := (p_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone; day_number := extract(dow from local_start);
  if p_starts_at < now() + make_interval(mins => s.min_notice_minutes) or p_starts_at > now() + make_interval(days => s.max_advance_days) then raise exception 'outside_booking_window'; end if;
  select * into window_row from public.booking_availability where service_id=s.id and weekday=day_number and enabled=true and start_time <= local_start::time and end_time >= local_end::time; if not found then raise exception 'outside_availability'; end if;
  select exists(select 1 from public.booking_blocked_dates where service_id=s.id and blocked_date=local_start::date) into blocked; if blocked then raise exception 'blocked_date'; end if;
  if exists(select 1 from public.booking_time_blocks where service_id=s.id and starts_at < p_starts_at + make_interval(mins => s.duration_minutes) and ends_at > p_starts_at) then raise exception 'blocked_time'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.id::text || p_starts_at::text, 0));
  if exists(select 1 from public.bookings where service_id=s.id and status in ('pending','confirmed') and starts_at < p_starts_at + make_interval(mins => s.duration_minutes) and ends_at > p_starts_at) then raise exception 'slot_taken'; end if;
  insert into public.bookings(service_id,creator_id,customer_name,customer_email,customer_phone,customer_note,starts_at,ends_at,timezone,status,payment_status,public_token) values(s.id,s.creator_id,trim(p_customer_name),lower(trim(p_customer_email)),nullif(trim(p_customer_phone),''),nullif(trim(p_customer_note),''),p_starts_at,p_starts_at+make_interval(mins=>s.duration_minutes),s.timezone,case when s.price_minor=0 then 'confirmed' else 'pending' end,case when s.price_minor=0 then 'not_required' else 'pending' end,encode(gen_random_bytes(24),'hex')) returning * into b;
  insert into public.booking_notifications(booking_id,notification_type,status) values(b.id,'confirmation','not_configured'); return b;
exception when unique_violation then raise exception 'slot_taken';
end; $$;
revoke all on function public.create_public_booking(uuid,timestamptz,text,text,text,text) from public; grant execute on function public.create_public_booking(uuid,timestamptz,text,text,text,text) to anon, authenticated;
