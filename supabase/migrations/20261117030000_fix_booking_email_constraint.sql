-- Keep the bookings table constraint consistent with the corrected public booking RPC.
alter table public.bookings drop constraint if exists bookings_customer_email_check;
alter table public.bookings add constraint bookings_customer_email_check check (customer_email ~* '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$');
