create table if not exists public.booking_services (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '',
  image_path text,
  duration_minutes integer not null check (duration_minutes between 5 and 1440),
  buffer_minutes integer not null default 0 check (buffer_minutes between 0 and 240),
  price_minor bigint not null default 0 check (price_minor >= 0),
  currency text not null default 'INR' check (char_length(currency) = 3),
  location_type text not null default 'online' check (location_type in ('online','in_person','custom')),
  location_details text,
  min_notice_minutes integer not null default 60 check (min_notice_minutes >= 0),
  max_advance_days integer not null default 60 check (max_advance_days between 1 and 730),
  cancellation_notice_hours integer not null default 24 check (cancellation_notice_hours >= 0),
  timezone text not null default 'Asia/Kolkata',
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, slug)
);
create table if not exists public.booking_availability (
  id uuid primary key default gen_random_uuid(), service_id uuid not null references public.booking_services(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), start_time time not null, end_time time not null, enabled boolean not null default true,
  unique(service_id, weekday), check (end_time > start_time)
);
create table if not exists public.booking_blocked_dates (
  id uuid primary key default gen_random_uuid(), service_id uuid not null references public.booking_services(id) on delete cascade,
  blocked_date date not null, reason text, unique(service_id, blocked_date)
);
create table if not exists public.booking_time_blocks (
  id uuid primary key default gen_random_uuid(), service_id uuid not null references public.booking_services(id) on delete cascade,
  starts_at timestamptz not null, ends_at timestamptz not null, reason text, check (ends_at > starts_at)
);
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(), service_id uuid not null references public.booking_services(id) on delete restrict,
  creator_id uuid not null references auth.users(id) on delete cascade, customer_name text not null check (char_length(customer_name) between 1 and 160),
  customer_email text not null check (customer_email ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'), customer_phone text,
  customer_note text, internal_note text, starts_at timestamptz not null, ends_at timestamptz not null, timezone text not null,
  status text not null default 'confirmed' check (status in ('pending','confirmed','cancelled','completed','no_show')),
  payment_status text not null default 'not_required' check (payment_status in ('not_required','pending','captured','failed','refunded')),
  public_token text not null unique, cancelled_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create table if not exists public.booking_notifications (
  id uuid primary key default gen_random_uuid(), booking_id uuid not null references public.bookings(id) on delete cascade,
  notification_type text not null check (notification_type in ('confirmation','cancellation','reschedule','reminder')),
  status text not null default 'not_configured' check (status in ('pending','sent','failed','not_configured')),
  scheduled_for timestamptz not null default now(), sent_at timestamptz, created_at timestamptz not null default now(), unique(booking_id, notification_type)
);
create index if not exists booking_services_creator_idx on public.booking_services(creator_id, status);
create index if not exists booking_services_public_idx on public.booking_services(slug, status);
create index if not exists booking_availability_service_idx on public.booking_availability(service_id, weekday);
create index if not exists booking_dates_service_idx on public.booking_blocked_dates(service_id, blocked_date);
create index if not exists bookings_creator_date_idx on public.bookings(creator_id, starts_at desc);
create index if not exists bookings_service_date_idx on public.bookings(service_id, starts_at);
create unique index if not exists bookings_active_slot_idx on public.bookings(service_id, starts_at) where status in ('pending','confirmed');

alter table public.booking_services enable row level security; alter table public.booking_availability enable row level security; alter table public.booking_blocked_dates enable row level security; alter table public.booking_time_blocks enable row level security; alter table public.bookings enable row level security; alter table public.booking_notifications enable row level security;
grant select on public.booking_services, public.booking_availability to anon, authenticated;
grant select, insert, update, delete on public.booking_services, public.booking_availability, public.booking_blocked_dates, public.booking_time_blocks, public.bookings, public.booking_notifications to authenticated;
create policy booking_services_public_read on public.booking_services for select to anon, authenticated using (status = 'published');
create policy booking_services_owner_all on public.booking_services for all to authenticated using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));
create policy booking_availability_public_read on public.booking_availability for select to anon, authenticated using (exists(select 1 from public.booking_services s where s.id=service_id and s.status='published'));
create policy booking_availability_owner_all on public.booking_availability for all to authenticated using (exists(select 1 from public.booking_services s where s.id=service_id and s.creator_id=(select auth.uid()))) with check (exists(select 1 from public.booking_services s where s.id=service_id and s.creator_id=(select auth.uid())));
create policy booking_dates_owner_all on public.booking_blocked_dates for all to authenticated using (exists(select 1 from public.booking_services s where s.id=service_id and s.creator_id=(select auth.uid()))) with check (exists(select 1 from public.booking_services s where s.id=service_id and s.creator_id=(select auth.uid())));
create policy booking_blocks_owner_all on public.booking_time_blocks for all to authenticated using (exists(select 1 from public.booking_services s where s.id=service_id and s.creator_id=(select auth.uid()))) with check (exists(select 1 from public.booking_services s where s.id=service_id and s.creator_id=(select auth.uid())));
create policy bookings_owner_read on public.bookings for select to authenticated using (creator_id=(select auth.uid()));
create policy bookings_owner_update on public.bookings for update to authenticated using (creator_id=(select auth.uid())) with check (creator_id=(select auth.uid()));
create policy booking_notifications_owner_read on public.booking_notifications for select to authenticated using (exists(select 1 from public.bookings b where b.id=booking_id and b.creator_id=(select auth.uid())));
revoke all on public.bookings, public.booking_notifications from anon;

create or replace function public.create_public_booking(p_service_id uuid, p_starts_at timestamptz, p_customer_name text, p_customer_email text, p_customer_phone text default null, p_customer_note text default null)
returns public.bookings language plpgsql security definer set search_path = public as $$
declare s public.booking_services; b public.bookings; local_start timestamp; local_end timestamp; day_number int; window_row public.booking_availability; blocked boolean;
begin
  select * into s from public.booking_services where id=p_service_id and status='published'; if not found then raise exception 'service_unavailable'; end if;
  if p_customer_name is null or length(trim(p_customer_name))=0 or p_customer_email !~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' then raise exception 'invalid_customer'; end if;
  local_start := p_starts_at at time zone s.timezone; local_end := (p_starts_at + make_interval(mins => s.duration_minutes)) at time zone s.timezone; day_number := extract(dow from local_start);
  if p_starts_at < now() + make_interval(mins => s.min_notice_minutes) or p_starts_at > now() + make_interval(days => s.max_advance_days) then raise exception 'outside_booking_window'; end if;
  select * into window_row from public.booking_availability where service_id=s.id and weekday=day_number and enabled=true and start_time <= local_start::time and end_time >= local_end::time;
  if not found then raise exception 'outside_availability'; end if;
  select exists(select 1 from public.booking_blocked_dates where service_id=s.id and blocked_date=local_start::date) into blocked; if blocked then raise exception 'blocked_date'; end if;
  if exists(select 1 from public.booking_time_blocks where service_id=s.id and starts_at < p_starts_at + make_interval(mins => s.duration_minutes) and ends_at > p_starts_at) then raise exception 'blocked_time'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.id::text || p_starts_at::text, 0));
  if exists(select 1 from public.bookings where service_id=s.id and status in ('pending','confirmed') and starts_at < p_starts_at + make_interval(mins => s.duration_minutes) and ends_at > p_starts_at) then raise exception 'slot_taken'; end if;
  insert into public.bookings(service_id,creator_id,customer_name,customer_email,customer_phone,customer_note,starts_at,ends_at,timezone,status,payment_status,public_token) values(s.id,s.creator_id,trim(p_customer_name),lower(trim(p_customer_email)),nullif(trim(p_customer_phone),''),nullif(trim(p_customer_note),''),p_starts_at,p_starts_at+make_interval(mins=>s.duration_minutes),s.timezone,case when s.price_minor=0 then 'confirmed' else 'pending' end,case when s.price_minor=0 then 'not_required' else 'pending' end,encode(gen_random_bytes(24),'hex')) returning * into b;
  insert into public.booking_notifications(booking_id,notification_type,status) values(b.id,'confirmation','not_configured'); return b;
exception when unique_violation then raise exception 'slot_taken';
end; $$;
revoke all on function public.create_public_booking(uuid,timestamptz,text,text,text,text) from public; grant execute on function public.create_public_booking(uuid,timestamptz,text,text,text,text) to anon, authenticated;
