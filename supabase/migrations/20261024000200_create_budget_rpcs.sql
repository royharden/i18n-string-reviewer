create function public.reserve_budget(
  p_request_id uuid, p_attempt integer, p_user uuid, p_provider text,
  p_model text, p_prompt_hash text, p_question_ids text[], p_estimate numeric,
  p_cap numeric, p_price_version text
) returns table (ledger_id uuid, status text, created boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_existing public.call_ledger%rowtype;
  v_day date := (now() at time zone 'utc')::date;
  v_reserved_day date;
  v_id uuid;
  v_status text;
  v_fault text;
begin
  if p_estimate is null or p_estimate::text in ('NaN', 'Infinity', '-Infinity') or p_estimate <= 0
     or p_cap is null or p_cap::text in ('NaN', 'Infinity', '-Infinity') or p_cap < 0 then
    raise exception 'invalid budget amount' using errcode = '22023';
  end if;
  -- Reserve upward and cap downward at the stored precision, never the reverse.
  p_estimate := ceil(p_estimate * 100000000) / 100000000;
  p_cap := floor(p_cap * 100000000) / 100000000;
  if p_estimate > 999999.99999999 or p_cap > 999999.99999999
     or p_request_id is null or p_user is null or p_attempt is null or p_attempt < 0
     or p_provider is null or p_provider not in ('anthropic', 'typesafe', 'mock')
     or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     or p_prompt_hash is null or p_prompt_hash !~ '^[a-f0-9]{64}$'
     or p_price_version is null or p_price_version !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     or p_question_ids is null or cardinality(p_question_ids) > 32
     or exists (select 1 from unnest(p_question_ids) q where q is null or q !~ '^q[0-9]{1,5}$') then
    raise exception 'invalid accounting metadata' using errcode = '22023';
  end if;

  -- Serialize ownership of this attempt BEFORE checking for an existing row.
  -- Hash collisions only serialize unrelated attempts; they cannot admit extra spend.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user::text || '/' || p_request_id::text || '/' || p_attempt::text, 0));
  select l.* into v_existing from public.call_ledger l
    where l.user_id = p_user and l.request_id = p_request_id and l.attempt = p_attempt;
  if found then
    return query select v_existing.id, v_existing.status, false;
    return;
  end if;

  insert into public.daily_budget(day, cap_usd) values (v_day, p_cap)
    on conflict (day) do update set cap_usd = excluded.cap_usd, updated_at = now()
    where daily_budget.cap_usd is distinct from excluded.cap_usd;
  -- This single conditional update, with the row lock held until commit, owns capacity.
  update public.daily_budget d
    set committed_usd = d.committed_usd + p_estimate, updated_at = now()
    where d.day = v_day and d.fault is null and d.committed_usd + p_estimate <= d.cap_usd
    returning d.day into v_reserved_day;
  if found then
    v_status := 'reserved';
  else
    select d.fault into v_fault from public.daily_budget d where d.day = v_day;
    v_status := case when v_fault is null then 'refused_budget' else 'refused_fault' end;
  end if;
  insert into public.call_ledger(request_id, attempt, user_id, budget_day, provider, model_id,
    prompt_hash, question_ids, reserved_usd, price_table_version, status)
    values (p_request_id, p_attempt, p_user, v_day, p_provider, p_model,
      p_prompt_hash, p_question_ids, p_estimate, p_price_version, v_status)
    returning id into v_id;
  return query select v_id, v_status, true;
end;
$$;

create function public.reconcile_budget(
  p_ledger_id uuid, p_status text, p_actual numeric, p_input integer,
  p_output integer, p_raw jsonb, p_latency integer
) returns table (ledger_id uuid, status text)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_ledger_id is null or p_status is null or p_status not in ('ok', 'provider_error', 'unknown')
     or (p_status = 'unknown' and p_actual is not null)
     or (p_status = 'ok' and p_actual is null)
     or (p_actual is not null and (p_actual::text in ('NaN', 'Infinity', '-Infinity') or p_actual < 0 or p_actual > 999999.99999999))
     or p_input < 0 or p_output < 0 or p_latency < 0 then
    raise exception 'invalid settlement' using errcode = '22023';
  end if;
  -- Only numeric usage counters may enter the durable ledger, never arbitrary API JSON.
  if p_raw is not null then
    if jsonb_typeof(p_raw) <> 'object' or (p_raw - 'input_tokens' - 'output_tokens') <> '{}'::jsonb then
      raise exception 'invalid raw usage' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_each(p_raw) e where jsonb_typeof(e.value) <> 'number') then
      raise exception 'invalid raw usage' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_each_text(p_raw) e
        where e.value::numeric < 0 or e.value::numeric > 2147483647 or trunc(e.value::numeric) <> e.value::numeric) then
      raise exception 'invalid raw usage' using errcode = '22023';
    end if;
  end if;
  if p_actual is not null then p_actual := ceil(p_actual * 100000000) / 100000000; end if;
  with settled as (
    update public.call_ledger l set status = p_status, cost_usd = p_actual,
      input_tokens = p_input, output_tokens = p_output, raw_usage = p_raw,
      latency_ms = p_latency, reconciled_at = now()
      where l.id = p_ledger_id and l.status = 'reserved'
      returning l.budget_day, l.reserved_usd
  )
  update public.daily_budget d set
    committed_usd = d.committed_usd - case
      when p_actual is null then 0
      when p_actual <= s.reserved_usd then s.reserved_usd - p_actual
      else 0 end,
    fault = case when p_actual > s.reserved_usd then coalesce(d.fault, 'overrun ' || p_ledger_id::text) else d.fault end,
    updated_at = now()
    from settled s where d.day = s.budget_day;
  -- A duplicate settle returns current state and changes no money, including on another day.
  return query select l.id, l.status from public.call_ledger l where l.id = p_ledger_id;
end;
$$;

revoke execute on function public.reserve_budget(uuid, integer, uuid, text, text, text, text[], numeric, numeric, text) from public, anon, authenticated;
revoke execute on function public.reconcile_budget(uuid, text, numeric, integer, integer, jsonb, integer) from public, anon, authenticated;
grant execute on function public.reserve_budget(uuid, integer, uuid, text, text, text, text[], numeric, numeric, text) to service_role;
grant execute on function public.reconcile_budget(uuid, text, numeric, integer, integer, jsonb, integer) to service_role;
