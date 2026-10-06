-- LiftLog — progress photos. Paste this whole file into the Supabase SQL
-- Editor and run it once (it is safe to run again). It is the migration
-- `progress_photos`: the photos table, shaped like every other synced table,
-- plus a private Storage bucket where each user can only reach their own
-- folder.
--
--   Path convention: <user_id>/<photo_id>.jpg. The first folder segment IS the
--   owner, so the policies below need no extra table to decide access.
--   The bucket is private: nothing is reachable without a signed-in user's
--   token, and the anon key alone gets nothing.
--
-- Until this has run, the app still works and still syncs sets and weigh-ins;
-- only the photo part of each sync reports that the server needs this update.

-- ---------------------------------------------------------------- table

create table if not exists public.photos (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  taken_at          text not null,
  pose              text not null default 'front',
  note              text,
  width             integer,
  height            integer,
  bytes             integer,
  created_at        text not null,
  updated_at        text not null,
  deleted           smallint not null default 0,
  server_updated_at timestamptz not null default now()
);

drop trigger if exists set_server_updated_at on public.photos;
create trigger set_server_updated_at before update on public.photos
  for each row execute function public.set_server_updated_at();

create index if not exists photos_sync_idx on public.photos (user_id, server_updated_at);

alter table public.photos enable row level security;
drop policy if exists own_rows on public.photos;
create policy own_rows on public.photos
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.photos to authenticated;
revoke all on public.photos from anon;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('progress-photos', 'progress-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "progress photos: own folder read"   on storage.objects;
drop policy if exists "progress photos: own folder insert" on storage.objects;
drop policy if exists "progress photos: own folder update" on storage.objects;
drop policy if exists "progress photos: own folder delete" on storage.objects;

create policy "progress photos: own folder read" on storage.objects
  for select to authenticated
  using (bucket_id = 'progress-photos'
         and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "progress photos: own folder insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'progress-photos'
              and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "progress photos: own folder update" on storage.objects
  for update to authenticated
  using (bucket_id = 'progress-photos'
         and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'progress-photos'
              and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "progress photos: own folder delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'progress-photos'
         and (storage.foldername(name))[1] = (select auth.uid())::text);
