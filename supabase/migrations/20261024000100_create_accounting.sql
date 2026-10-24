-- Accounting metadata only: never store source, target, prompts, or model replies.
create table public.daily_budget (
  day date primary key,
  cap_usd numeric(14,8) not null check (cap_usd >= 0 and cap_usd::text not in ('NaN', 'Infinity', '-Infinity')),
  committed_usd numeric(14,8) not null default 0 check (committed_usd >= 0 and committed_usd::text not in ('NaN', 'Infinity', '-Infinity')),
  fault text,
  updated_at timestamptz not null default now()
);

create table public.call_ledger (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  attempt integer not null check (attempt >= 0),
  user_id uuid not null,
  budget_day date not null references public.daily_budget(day),
  provider text not null,
  model_id text not null,
  prompt_hash text not null check (prompt_hash ~ '^[a-f0-9]{64}$'),
  question_ids text[] not null,
  reserved_usd numeric(14,8) not null check (reserved_usd > 0 and reserved_usd::text not in ('NaN', 'Infinity', '-Infinity')),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  raw_usage jsonb,
  cost_usd numeric(14,8) check (cost_usd >= 0 and cost_usd::text not in ('NaN', 'Infinity', '-Infinity')),
  price_table_version text not null,
  latency_ms integer check (latency_ms >= 0),
  status text not null check (status in ('reserved', 'ok', 'provider_error', 'unknown', 'refused_budget', 'refused_fault')),
  created_at timestamptz not null default now(),
  reconciled_at timestamptz,
  unique (user_id, request_id, attempt)
);

alter table public.daily_budget enable row level security;
alter table public.call_ledger enable row level security;
-- Deliberately no RLS policies. Only service-role RPCs may operate accounting.
revoke all on table public.daily_budget, public.call_ledger from public, anon, authenticated;
