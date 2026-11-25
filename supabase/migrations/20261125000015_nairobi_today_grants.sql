-- nairobi_today() (migration 11) was created executable by everyone, including
-- the logged-out anon role. It only returns a date, but nothing should be
-- callable without signing in. Found by docs/security/verify-rls.sql.
revoke execute on function public.nairobi_today() from public, anon;
grant execute on function public.nairobi_today() to authenticated, service_role;