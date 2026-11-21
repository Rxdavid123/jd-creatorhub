begin;

create table if not exists public.booking_change_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  request_type text not null check (request_type in ('cancellation', 'reschedule')),
  reason text not null check (char_length(trim(reason)) between 1 and 1000),
  requested_starts_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decision_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint reschedule_requires_time check ((request_type = 'reschedule' and requested_starts_at is not null) or (request_type = 'cancellation' and requested_starts_at is null))
);
create unique index if not exists booking_change_requests_one_pending_idx on public.booking_change_requests(booking_id) where status = 'pending';
create index if not exists booking_change_requests_booking_idx on public.booking_change_requests(booking_id, created_at desc);
alter table public.booking_change_requests enable row level security;
revoke all on public.booking_change_requests from anon, authenticated;
grant select on public.booking_change_requests to authenticated;
grant select, insert, update, delete on public.booking_change_requests to service_role;
drop policy if exists booking_change_requests_creator_read on public.booking_change_requests;
create policy booking_change_requests_creator_read on public.booking_change_requests for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.creator_id = (select auth.uid())));

alter table public.booking_notifications
  add column if not exists change_request_id uuid references public.booking_change_requests(id) on delete cascade;
alter table public.booking_notifications drop constraint if exists booking_notifications_notification_type_check;
alter table public.booking_notifications add constraint booking_notifications_notification_type_check
  check (notification_type in ('confirmation','cancellation','reschedule','reminder','new_booking','creator_confirmation','creator_cancellation','change_request_submitted','change_request_decision'));
alter table public.booking_notifications drop constraint if exists booking_notifications_booking_id_notification_type_key;
create unique index if not exists booking_notifications_event_unique_idx
  on public.booking_notifications (booking_id, notification_type, change_request_id) nulls not distinct;

create or replace function public.submit_booking_change_request(p_token text, p_request_type text, p_reason text, p_requested_starts_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings; s public.booking_services; local_start timestamp; local_end timestamp; avail public.booking_availability; req public.booking_change_requests;
begin
  if p_request_type not in ('cancellation','reschedule') or p_reason is null or char_length(trim(p_reason)) not between 1 and 1000 then raise exception 'invalid_request'; end if;
  if (p_request_type = 'reschedule') <> (p_requested_starts_at is not null) then raise exception 'invalid_request'; end if;
  select * into b from public.bookings where public.bookings.public_token = p_token for update;
  if not found then raise exception 'booking_not_found'; end if;
  if b.status not in ('pending','confirmed') then raise exception 'booking_not_active'; end if;
  if exists(select 1 from public.booking_change_requests r where r.booking_id = b.id and r.status = 'pending') then raise exception 'request_pending'; end if;
  if p_request_type = 'reschedule' then
    select * into s from public.booking_services where id = b.service_id;
    if p_requested_starts_at <= now() + make_interval(mins => s.min_notice_minutes) or p_requested_starts_at > now() + make_interval(days => s.max_advance_days) then raise exception 'outside_booking_window'; end if;
    perform pg_advisory_xact_lock(hashtextextended(s.id::text || p_requested_starts_at::text, 0));
    local_start := p_requested_starts_at at time zone s.timezone;
    local_end := (p_requested_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone;
    select * into avail from public.booking_availability where service_id = s.id and weekday = extract(dow from local_start) and enabled and start_time <= local_start::time and end_time >= local_end::time;
    if not found then raise exception 'outside_availability'; end if;
    if exists(select 1 from public.booking_blocked_dates where service_id = s.id and blocked_date = local_start::date) then raise exception 'blocked_date'; end if;
    if exists(select 1 from public.booking_time_blocks where service_id = s.id and starts_at < p_requested_starts_at + make_interval(mins => s.duration_minutes) and ends_at > p_requested_starts_at) then raise exception 'blocked_time'; end if;
    if exists(select 1 from public.bookings x where x.service_id = s.id and x.id <> b.id and x.status in ('pending','confirmed') and x.starts_at < p_requested_starts_at + make_interval(mins => s.duration_minutes) and x.ends_at > p_requested_starts_at) then raise exception 'slot_taken'; end if;
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
declare r public.booking_change_requests; b public.bookings; s public.booking_services; local_start timestamp; local_end timestamp; avail public.booking_availability;
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
      if r.requested_starts_at <= now() + make_interval(mins => s.min_notice_minutes) or r.requested_starts_at > now() + make_interval(days => s.max_advance_days) then raise exception 'outside_booking_window'; end if;
      perform pg_advisory_xact_lock(hashtextextended(s.id::text || r.requested_starts_at::text, 0));
      local_start := r.requested_starts_at at time zone s.timezone;
      local_end := (r.requested_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone;
      select * into avail from public.booking_availability where service_id = s.id and weekday = extract(dow from local_start) and enabled and start_time <= local_start::time and end_time >= local_end::time;
      if not found or exists(select 1 from public.booking_blocked_dates where service_id = s.id and blocked_date = local_start::date) or exists(select 1 from public.booking_time_blocks where service_id = s.id and starts_at < r.requested_starts_at + make_interval(mins => s.duration_minutes) and ends_at > r.requested_starts_at) or exists(select 1 from public.bookings x where x.service_id = s.id and x.id <> b.id and x.status in ('pending','confirmed') and x.starts_at < r.requested_starts_at + make_interval(mins => s.duration_minutes) and x.ends_at > r.requested_starts_at) then raise exception 'slot_taken'; end if;
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
