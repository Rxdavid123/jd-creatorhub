create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160), slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text not null default '', thumbnail_path text, category text not null default 'General', difficulty text not null default 'beginner' check (difficulty in ('beginner','intermediate','advanced')),
  language text not null default 'English', price_minor bigint not null default 0 check (price_minor >= 0), currency text not null default 'INR' check (char_length(currency)=3),
  status text not null default 'draft' check (status in ('draft','published','unpublished','deleted')), published_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.course_sections (
  id uuid primary key default gen_random_uuid(), course_id uuid not null references public.courses(id) on delete cascade, title text not null, position integer not null check (position >= 0), unique(course_id, position)
);
create table if not exists public.course_lessons (
  id uuid primary key default gen_random_uuid(), section_id uuid not null references public.course_sections(id) on delete cascade, title text not null, slug text not null, position integer not null check (position >= 0), lesson_type text not null default 'text' check (lesson_type in ('text','video','resource')), content text not null default '', video_path text, is_preview boolean not null default false, duration_minutes integer check (duration_minutes is null or duration_minutes >= 0), unique(section_id, position), unique(section_id, slug)
);
create table if not exists public.course_resources (
  id uuid primary key default gen_random_uuid(), lesson_id uuid not null references public.course_lessons(id) on delete cascade, name text not null, storage_path text not null, mime_type text, position integer not null default 0 check (position >= 0), unique(lesson_id, storage_path)
);
create table if not exists public.course_enrollments (
  id uuid primary key default gen_random_uuid(), course_id uuid not null references public.courses(id) on delete cascade, student_id uuid not null references auth.users(id) on delete cascade, order_id uuid references public.orders(id) on delete set null, payment_id uuid references public.razorpay_payments(id) on delete set null, payment_status text not null default 'captured' check (payment_status in ('free','captured','refunded','cancelled')), enrolled_at timestamptz not null default now(), unique(course_id, student_id)
);
create table if not exists public.course_lesson_progress (
  id uuid primary key default gen_random_uuid(), enrollment_id uuid not null references public.course_enrollments(id) on delete cascade, lesson_id uuid not null references public.course_lessons(id) on delete cascade, completed_at timestamptz, updated_at timestamptz not null default now(), unique(enrollment_id, lesson_id)
);
create table if not exists public.course_certificates (
  id uuid primary key default gen_random_uuid(), enrollment_id uuid not null unique references public.course_enrollments(id) on delete cascade, certificate_number text not null unique, issued_at timestamptz not null default now()
);
create index if not exists courses_owner_idx on public.courses(owner_id, updated_at desc);
create index if not exists courses_slug_published_idx on public.courses(slug, status);
create index if not exists course_sections_course_idx on public.course_sections(course_id, position);
create index if not exists course_lessons_section_idx on public.course_lessons(section_id, position);
create index if not exists course_enrollments_student_idx on public.course_enrollments(student_id, enrolled_at desc);
create index if not exists course_progress_enrollment_idx on public.course_lesson_progress(enrollment_id);

alter table public.courses enable row level security; alter table public.course_sections enable row level security; alter table public.course_lessons enable row level security; alter table public.course_resources enable row level security; alter table public.course_enrollments enable row level security; alter table public.course_lesson_progress enable row level security; alter table public.course_certificates enable row level security;
grant select on public.courses, public.course_sections, public.course_lessons, public.course_resources to anon, authenticated;
grant select, insert, update, delete on public.courses, public.course_sections, public.course_lessons, public.course_resources to authenticated;
grant select on public.course_enrollments, public.course_lesson_progress, public.course_certificates to authenticated;
grant insert, update on public.course_lesson_progress to authenticated;
create policy courses_public_read on public.courses for select to anon, authenticated using (status = 'published' or owner_id = (select auth.uid()));
create policy courses_owner_write on public.courses for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy course_sections_read on public.course_sections for select to anon, authenticated using (exists (select 1 from public.courses c where c.id = course_id and (c.status = 'published' or c.owner_id = (select auth.uid()))));
create policy course_sections_owner_write on public.course_sections for all to authenticated using (exists (select 1 from public.courses c where c.id = course_id and c.owner_id = (select auth.uid()))) with check (exists (select 1 from public.courses c where c.id = course_id and c.owner_id = (select auth.uid())));
create policy course_lessons_read on public.course_lessons for select to anon, authenticated using (exists (select 1 from public.course_sections s join public.courses c on c.id=s.course_id where s.id=section_id and (c.status='published' or c.owner_id=(select auth.uid()))));
create policy course_lessons_owner_write on public.course_lessons for all to authenticated using (exists (select 1 from public.course_sections s join public.courses c on c.id=s.course_id where s.id=section_id and c.owner_id=(select auth.uid()))) with check (exists (select 1 from public.course_sections s join public.courses c on c.id=s.course_id where s.id=section_id and c.owner_id=(select auth.uid())));
create policy course_resources_owner on public.course_resources for all to authenticated using (exists (select 1 from public.course_lessons l join public.course_sections s on s.id=l.section_id join public.courses c on c.id=s.course_id where l.id=lesson_id and c.owner_id=(select auth.uid()))) with check (exists (select 1 from public.course_lessons l join public.course_sections s on s.id=l.section_id join public.courses c on c.id=s.course_id where l.id=lesson_id and c.owner_id=(select auth.uid())));
create policy enrollments_student_read on public.course_enrollments for select to authenticated using (student_id=(select auth.uid()));
create policy progress_student on public.course_lesson_progress for all to authenticated using (exists (select 1 from public.course_enrollments e where e.id=enrollment_id and e.student_id=(select auth.uid()))) with check (exists (select 1 from public.course_enrollments e where e.id=enrollment_id and e.student_id=(select auth.uid())));
create policy certificates_student_read on public.course_certificates for select to authenticated using (exists (select 1 from public.course_enrollments e where e.id=enrollment_id and e.student_id=(select auth.uid())));
revoke all on public.course_enrollments, public.course_certificates from anon;
