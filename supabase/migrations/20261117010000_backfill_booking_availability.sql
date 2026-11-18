-- Add only missing weekday defaults for existing services; never overwrite creator schedules.
insert into public.booking_availability (service_id, weekday, start_time, end_time, enabled)
select s.id, weekdays.weekday, '09:00'::time, '17:00'::time, true
from public.booking_services s
cross join (values (1),(2),(3),(4),(5)) as weekdays(weekday)
where not exists (
  select 1 from public.booking_availability a
  where a.service_id = s.id and a.weekday = weekdays.weekday
);
