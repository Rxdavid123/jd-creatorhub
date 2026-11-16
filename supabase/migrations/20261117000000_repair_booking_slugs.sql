-- Repairs legacy blank slugs without deleting or recreating booking data.
with candidates as (
  select id, store_id, lower(regexp_replace(trim(name), '[^a-zA-Z0-9]+', '-', 'g')) as base_slug
  from public.booking_services
  where slug = '' or slug is null
), normalized as (
  select id, store_id, trim(both '-' from base_slug) as base_slug
  from candidates
), repaired as (
  select id, store_id, case when base_slug = '' then 'service-' || left(replace(id::text, '-', ''), 8) else base_slug end as proposed_slug
  from normalized
), ranked as (
  select id, row_number() over (partition by store_id, proposed_slug order by id) as duplicate_number, proposed_slug
  from repaired
)
update public.booking_services service
set slug = case when ranked.duplicate_number = 1 then ranked.proposed_slug else ranked.proposed_slug || '-' || ranked.duplicate_number end,
    updated_at = now()
from ranked
where service.id = ranked.id;
