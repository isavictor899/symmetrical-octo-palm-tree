-- Resetting a console member's authenticator (lost phone) from the Team page.
-- The platform-admin edge function removes the factor with the Auth admin API
-- after this check: the actor is an owner, the target is on the console team,
-- and it is not the actor themselves.
create or replace function public.platform_assert_member(p_actor uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_email text;
begin
  perform public.platform_assert_actor_role(p_actor, 'owner');
  if p_actor = p_user then
    raise exception 'You cannot reset your own authenticator. Ask another owner.' using errcode = 'P0001';
  end if;
  select email into v_email from public.platform_admins where user_id = p_user;
  if v_email is null and not exists (select 1 from public.platform_admins where user_id = p_user) then
    raise exception 'That person is not on the console team.' using errcode = 'P0001';
  end if;
  insert into public.platform_audit_log (actor, organization_id, action, details)
  values (p_actor, null, 'team_mfa_reset', jsonb_build_object('user_id', p_user, 'email', v_email));
end;
$$;
revoke all on function public.platform_assert_member(uuid, uuid) from public, anon, authenticated;