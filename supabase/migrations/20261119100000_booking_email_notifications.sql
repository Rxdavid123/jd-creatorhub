alter table public.booking_notifications
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_error text,
  add column if not exists provider_message_id text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.booking_notifications
  drop constraint if exists booking_notifications_notification_type_check,
  add constraint booking_notifications_notification_type_check
    check (notification_type in ('confirmation', 'cancellation', 'reschedule', 'reminder', 'new_booking', 'creator_confirmation', 'creator_cancellation')),
  drop constraint if exists booking_notifications_status_check,
  add constraint booking_notifications_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'not_configured')),
  alter column status set default 'pending';

create index if not exists booking_notifications_delivery_idx
  on public.booking_notifications (status, scheduled_for)
  where status in ('pending', 'failed', 'sending');

revoke insert, update, delete, truncate on public.booking_notifications from anon, authenticated;
grant select on public.booking_notifications to authenticated;
grant select, insert, update on public.booking_notifications to service_role;

create or replace function public.queue_booking_email_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  notification_type_value text;
begin
  if tg_table_name = 'booking_notifications' then
    if new.notification_type = 'confirmation' then
      update public.booking_notifications set status = 'pending', updated_at = now()
      where id = new.id and status = 'not_configured';
      insert into public.booking_notifications (booking_id, notification_type, status)
      values (new.booking_id, 'new_booking', 'pending')
      on conflict (booking_id, notification_type) do nothing;
    end if;
    return new;
  end if;

  if tg_table_name = 'bookings' and old.status is distinct from new.status then
    notification_type_value := case new.status
      when 'confirmed' then 'creator_confirmation'
      when 'cancelled' then 'creator_cancellation'
      else null
    end;
    if notification_type_value is not null then
      insert into public.booking_notifications (booking_id, notification_type, status)
      values (new.id, notification_type_value, 'pending')
      on conflict (booking_id, notification_type) do nothing;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.queue_booking_email_notifications() from public;
grant execute on function public.queue_booking_email_notifications() to anon, authenticated, service_role;

create trigger queue_booking_email_notifications_after_insert
  after insert on public.booking_notifications for each row
  execute function public.queue_booking_email_notifications();

create trigger queue_booking_email_notifications_after_status_update
  after update of status on public.bookings for each row
  execute function public.queue_booking_email_notifications();
