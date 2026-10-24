-- SOURCE ONLY during Dirty Mode. Later, as database owner on a fresh DISPOSABLE database:
-- psql --no-psqlrc --set ON_ERROR_STOP=1 --file supabase/tests/budget_concurrency.sql
-- This single-session script is NOT a concurrency test. Run budget_concurrency.mjs separately
-- against a fresh disposable database to release independent connections through a shared gate.
-- All fixtures here roll back. Never point this script at a live application's database.
begin;
create function pg_temp.accounting_assert(ok boolean, description text) returns void
language plpgsql as $$ begin if ok is distinct from true then raise exception 'accounting assertion: %', description; end if; end $$;

do $tests$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_user uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  a record;
  b record;
  s record;
  before_usd numeric;
  v_role text;
begin
  if exists (select 1 from public.daily_budget where day = v_day) then
    raise exception 'requires fresh disposable database with no budget for current UTC day';
  end if;
  select * into a from public.reserve_budget(v_request, 0, v_user, 'mock', 'mock-v1', repeat('a',64), array['q0'], 0.40, 1.00, 'test-v1');
  perform pg_temp.accounting_assert(a.status = 'reserved' and a.created, 'new reservation owns dispatch');
  select * into b from public.reserve_budget(v_request, 0, v_user, 'mock', 'mock-v1', repeat('a',64), array['q0'], 0.40, 1.00, 'test-v1');
  perform pg_temp.accounting_assert(b.ledger_id = a.ledger_id and b.status = 'reserved' and not b.created, 'duplicate in-flight attempt returns same row, created=false');
  perform pg_temp.accounting_assert((select committed_usd = 0.40 from public.daily_budget where day = v_day), 'duplicate does not reserve twice');
  select * into s from public.reconcile_budget(a.ledger_id, 'ok', 0.10, 4, 2, '{"input_tokens":4,"output_tokens":2}', 1);
  perform pg_temp.accounting_assert(s.status = 'ok', 'settled ok');
  perform public.reconcile_budget(a.ledger_id, 'ok', 0, 4, 2, '{}', 1);
  perform pg_temp.accounting_assert((select committed_usd = 0.10 from public.daily_budget where day = v_day), 'double reconcile refunds once');
  select * into b from public.reserve_budget(v_request, 0, v_user, 'mock', 'mock-v1', repeat('a',64), array['q0'], 0.40, 1.00, 'test-v1');
  perform pg_temp.accounting_assert(b.status = 'ok' and not b.created, 'settled duplicate remains duplicate');

  select * into a from public.reserve_budget(gen_random_uuid(), 0, v_user, 'mock', 'mock-v1', repeat('b',64), '{}'::text[], 0.20, 0.10, 'test-v1');
  perform pg_temp.accounting_assert(a.status = 'refused_budget', 'cap update preserves spend and refuses');
  perform pg_temp.accounting_assert((select cap_usd = 0.10 and committed_usd = 0.10 from public.daily_budget where day = v_day), 'cap update never resets committed');
  perform public.reconcile_budget(a.ledger_id, 'ok', 0, 0, 0, '{}', 0);
  perform pg_temp.accounting_assert((select status = 'refused_budget' from public.call_ledger where id = a.ledger_id), 'refusal cannot be settled/refunded');

  select * into a from public.reserve_budget(gen_random_uuid(), 0, v_user, 'mock', 'mock-v1', repeat('c',64), '{}'::text[], 0.20, 1, 'test-v1');
  perform public.reconcile_budget(a.ledger_id, 'unknown', null, null, null, null, 30);
  perform pg_temp.accounting_assert((select committed_usd = 0.30 from public.daily_budget where day = v_day), 'unknown keeps full charge');
  perform public.reconcile_budget(a.ledger_id, 'ok', 0, 0, 0, '{}', 0);
  perform pg_temp.accounting_assert((select committed_usd = 0.30 from public.daily_budget where day = v_day), 'unknown cannot later be refunded');

  -- Simulate an outstanding yesterday reservation without depending on wall-clock midnight.
  select * into a from public.reserve_budget(gen_random_uuid(), 0, v_user, 'mock', 'mock-v1', repeat('d',64), '{}'::text[], 0.20, 1, 'test-v1');
  insert into public.daily_budget(day, cap_usd, committed_usd) values(v_day - 1, 1, 0.20);
  update public.daily_budget set committed_usd = committed_usd - 0.20 where day = v_day;
  update public.call_ledger set budget_day = v_day - 1 where id = a.ledger_id;
  select committed_usd into before_usd from public.daily_budget where day = v_day;
  perform public.reconcile_budget(a.ledger_id, 'ok', 0.05, 0, 0, '{}', 0);
  perform pg_temp.accounting_assert((select committed_usd = 0.05 from public.daily_budget where day = v_day - 1), 'midnight settlement uses reservation day');
  perform pg_temp.accounting_assert((select committed_usd = before_usd from public.daily_budget where day = v_day), 'midnight settlement does not debit current day');

  select * into a from public.reserve_budget(gen_random_uuid(), 0, v_user, 'mock', 'mock-v1', repeat('e',64), '{}'::text[], 0.10, 1, 'test-v1');
  perform public.reconcile_budget(a.ledger_id, 'ok', 0.11, 0, 0, '{}', 0);
  perform pg_temp.accounting_assert((select fault is not null from public.daily_budget where day = v_day), 'overrun sets daily fault');
  select * into b from public.reserve_budget(gen_random_uuid(), 0, v_user, 'mock', 'mock-v1', repeat('f',64), '{}'::text[], 0.01, 2, 'test-v1');
  perform pg_temp.accounting_assert(b.status = 'refused_fault', 'overrun blocks despite cap increase');

  begin
    perform public.reserve_budget(gen_random_uuid(), 0, v_user, 'mock', 'mock-v1', repeat('a',64), '{}'::text[], -0.01, 1, 'test-v1');
    raise exception 'negative estimate accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.reserve_budget(gen_random_uuid(), 0, v_user, 'mock', 'mock-v1', repeat('a',64), '{}'::text[], 'NaN', 1, 'test-v1');
    raise exception 'NaN estimate accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.reconcile_budget(a.ledger_id, 'ok', 0, 0, 0, '{"model_reply":"must not persist"}', 0);
    raise exception 'unsafe raw usage accepted';
  exception when invalid_parameter_value then null; end;

  perform pg_temp.accounting_assert((select relrowsecurity from pg_class where oid = 'public.daily_budget'::regclass), 'daily RLS');
  perform pg_temp.accounting_assert((select relrowsecurity from pg_class where oid = 'public.call_ledger'::regclass), 'ledger RLS');
  perform pg_temp.accounting_assert(not exists(select 1 from pg_policies where schemaname = 'public' and tablename in ('daily_budget','call_ledger')), 'no policies');
  foreach v_role in array array['anon', 'authenticated'] loop
    perform pg_temp.accounting_assert(not has_table_privilege(v_role, 'public.daily_budget', 'SELECT'), 'daily table privilege revoked');
    perform pg_temp.accounting_assert(not has_table_privilege(v_role, 'public.call_ledger', 'SELECT'), 'ledger table privilege revoked');
    perform pg_temp.accounting_assert(not has_function_privilege(v_role, 'public.reserve_budget(uuid,integer,uuid,text,text,text,text[],numeric,numeric,text)', 'EXECUTE'), 'reserve execute revoked');
    perform pg_temp.accounting_assert(not has_function_privilege(v_role, 'public.reconcile_budget(uuid,text,numeric,integer,integer,jsonb,integer)', 'EXECUTE'), 'reconcile execute revoked');
    execute format('set local role %I', v_role);
    begin perform 1 from public.daily_budget; raise exception 'unauthorized daily SELECT accepted'; exception when insufficient_privilege then null; end;
    begin perform 1 from public.call_ledger; raise exception 'unauthorized ledger SELECT accepted'; exception when insufficient_privilege then null; end;
    begin
      perform public.reserve_budget(v_request, 0, v_user, 'mock', 'mock-v1', repeat('a',64), '{}'::text[], 0.01, 1, 'test-v1');
      raise exception 'unauthorized reserve accepted';
    exception when insufficient_privilege then null; end;
    begin
      perform public.reconcile_budget(a.ledger_id, 'ok', 0, 0, 0, '{}', 0);
      raise exception 'unauthorized reconcile accepted';
    exception when insufficient_privilege then null; end;
    reset role;
  end loop;
end;
$tests$;
rollback;
