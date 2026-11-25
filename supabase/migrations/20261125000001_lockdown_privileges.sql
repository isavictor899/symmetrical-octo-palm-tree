-- 20261125000001_lockdown_privileges.sql
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig, p.prorettype::regtype::text as ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind in ('f','p')
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    if fn.ret in ('trigger','event_trigger') then
      execute format('revoke all on function %s from authenticated', fn.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', fn.sig);
    end if;
  end loop;
end $$;

-- Insight generators: service role / cron only
revoke execute on function public.generate_restock_insights() from authenticated;
revoke execute on function public.refresh_restock_insights(uuid) from authenticated;

-- Tables and views
revoke all on all tables in schema public from anon;
revoke insert, delete, truncate, references, trigger on all tables in schema public from authenticated;
revoke update on all tables in schema public from authenticated;
grant update (name, theme_color) on public.shops to authenticated;  -- the only direct write the app makes

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke execute on functions from public, anon;

notify pgrst, 'reload schema';