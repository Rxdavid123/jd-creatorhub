create table if not exists public.download_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint download_tokens_expiry_check check (expires_at > created_at)
);

create index if not exists download_tokens_order_id_idx on public.download_tokens(order_id);
create index if not exists download_tokens_expires_at_idx on public.download_tokens(expires_at);

alter table public.download_tokens enable row level security;
revoke all on public.download_tokens from public, anon, authenticated;
grant all on public.download_tokens to service_role;

comment on table public.download_tokens is 'Hashed, short-lived guest/customer download capabilities. Service role only.';
