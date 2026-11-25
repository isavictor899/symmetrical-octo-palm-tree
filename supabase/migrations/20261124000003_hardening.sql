-- One staff row per login (the design assumes it). If this fails,
-- you have duplicates: find them with
-- select auth_user_id, count(*) from public.staff group by 1 having count(*) > 1;
create unique index if not exists staff_auth_user_id_key
  on public.staff (auth_user_id) where auth_user_id is not null;

-- AI insight quota (per user, per day)
create table if not exists public.ai_insight_calls (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_insight_calls_user_idx
  on public.ai_insight_calls (user_id, created_at desc);
alter table public.ai_insight_calls enable row level security;
revoke all on public.ai_insight_calls from public, anon, authenticated;

create or replace function public.consume_insight_quota(p_limit integer default 10)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if auth.uid() is null then return false; end if;
  select count(*) into v_count from public.ai_insight_calls
   where user_id = auth.uid() and created_at > now() - interval '1 day';
  if v_count >= p_limit then return false; end if;
  insert into public.ai_insight_calls (user_id) values (auth.uid());
  return true;
end;
$$;
revoke all on function public.consume_insight_quota(integer) from public, anon;
grant execute on function public.consume_insight_quota(integer) to authenticated;