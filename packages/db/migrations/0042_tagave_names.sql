-- The project was called liner before 0.9; database objects it created
-- carry that name. Rename them to tagave.
--
-- liner_display_artist (0028) becomes tagave_display_artist. A rename keeps
-- the function's identity, so the expression indexes built on it (0028,
-- 0040) stay valid and keep serving the queries, which now use the new name.
--
-- For one release a thin liner_display_artist stays as an alias, so an app
-- or worker still on 0.8 that runs against this database (a split install
-- mid-update, or TAGAVE_ALLOW_SCHEMA_SKEW) keeps working. 0.10 drops it.
--
-- The database and its user keep whatever names the install gave them: an
-- install from before 0.9 keeps "liner", new installs use "tagave".
do $$
begin
  if to_regprocedure('tagave_display_artist(text)') is null
     and to_regprocedure('liner_display_artist(text)') is not null then
    alter function liner_display_artist(text) rename to tagave_display_artist;
  end if;
end
$$;

create or replace function liner_display_artist(name text) returns text
language sql immutable parallel safe as $$
  select tagave_display_artist(name)
$$;
