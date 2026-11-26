-- Ending an announcement set ends_at = now(), which broke the "ends after it
-- starts" check for one that had not started yet (scheduled), or that started
-- in the same instant. Ending now also pulls a future start back, so a
-- scheduled announcement is simply cancelled.
create or replace function public.platform_end_announcement(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.platform_require('owner');
  update public.platform_announcements
     set starts_at = least(starts_at, now() - interval '1 second'),
         ends_at = now(),
         updated_at = now()
   where id = p_id and (ends_at is null or ends_at > now());
  if not found then raise exception 'That announcement has already ended.' using errcode = 'P0001'; end if;
  perform public.platform_log(null, 'announcement_ended', jsonb_build_object('id', p_id));
end;
$$;
revoke all on function public.platform_end_announcement(uuid) from public, anon;
grant execute on function public.platform_end_announcement(uuid) to authenticated;