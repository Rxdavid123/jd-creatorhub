create table if not exists public.course_product_links (
  product_id uuid primary key references public.products(id) on delete cascade,
  course_id uuid not null unique references public.courses(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.course_product_links enable row level security;
grant select on public.course_product_links to anon, authenticated;
revoke insert, update, delete on public.course_product_links from anon, authenticated;
create policy course_product_links_public_read on public.course_product_links for select to anon, authenticated using (exists (select 1 from public.courses c where c.id = course_id and c.status = 'published'));

create or replace function public.grant_course_enrollment(
  p_order_id uuid,
  p_student_id uuid,
  p_provider_payment_id text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_item public.order_items;
  v_course public.courses;
  v_enrollment_id uuid;
begin
  if p_order_id is null or p_student_id is null or nullif(trim(p_provider_payment_id), '') is null then return null; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.status = 'cancelled' then return null; end if;
  select * into v_payment from public.payments where order_id = p_order_id and provider = 'razorpay' and provider_payment_id = p_provider_payment_id and status = 'captured' for update;
  if not found then return null; end if;
  select * into v_item from public.order_items where order_id = p_order_id;
  if not found or (select count(*) from public.order_items where order_id = p_order_id) <> 1 or v_item.product_id is null then return null; end if;
  select c.* into v_course from public.course_product_links l join public.courses c on c.id = l.course_id where l.product_id = v_item.product_id and c.status = 'published' and c.price_minor = v_item.unit_price_minor and c.currency = v_order.currency;
  if not found then return null; end if;
  insert into public.course_enrollments(course_id, student_id, order_id, payment_id, payment_status)
  values (v_course.id, p_student_id, p_order_id, v_payment.id, 'captured')
  on conflict (course_id, student_id) do update set payment_status = 'captured', order_id = coalesce(public.course_enrollments.order_id, excluded.order_id), payment_id = coalesce(public.course_enrollments.payment_id, excluded.payment_id)
  returning id into v_enrollment_id;
  return v_enrollment_id;
end;
$$;
revoke all on function public.grant_course_enrollment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.grant_course_enrollment(uuid, uuid, text) to service_role;

insert into storage.buckets (id, name, public)
values ('course-files', 'course-files', false)
on conflict (id) do update set public = false;

create policy course_files_owner_read on storage.objects for select to authenticated using (bucket_id = 'course-files' and exists (select 1 from public.course_resources r join public.course_lessons l on l.id = r.lesson_id join public.course_sections s on s.id = l.section_id join public.courses c on c.id = s.course_id where r.storage_path = name and (c.owner_id = (select auth.uid()) or exists (select 1 from public.course_enrollments e where e.course_id = c.id and e.student_id = (select auth.uid()) and e.payment_status in ('free','captured')))));
create policy course_files_owner_insert on storage.objects for insert to authenticated with check (bucket_id = 'course-files' and exists (select 1 from public.courses c where c.owner_id = (select auth.uid()) and name like c.id::text || '/%'));
create policy course_files_owner_update on storage.objects for update to authenticated using (bucket_id = 'course-files' and exists (select 1 from public.courses c where c.owner_id = (select auth.uid()) and name like c.id::text || '/%')) with check (bucket_id = 'course-files' and exists (select 1 from public.courses c where c.owner_id = (select auth.uid()) and name like c.id::text || '/%'));
create policy course_files_owner_delete on storage.objects for delete to authenticated using (bucket_id = 'course-files' and exists (select 1 from public.courses c where c.owner_id = (select auth.uid()) and name like c.id::text || '/%'));
