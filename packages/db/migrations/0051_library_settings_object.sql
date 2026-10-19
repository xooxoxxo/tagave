-- libraries.settings is a JSON object. A writer that JSON.stringify'd the
-- settings and bound them through a postgres.js client that serializes jsonb
-- itself (any client without drizzle's pass-through jsonb serializer, e.g.
-- doctor reseal) stored them as a jsonb *string* holding the
-- object's text. JS readers parsed it back, but SQL on those rows saw no keys:
-- `settings->>'discogsToken'`, `?`, jsonb_set all came back NULL or wrong.
--
-- Unwrap each such string into the object it holds. A string wrapped more
-- than once is unwrapped until it is an object (at most 5 passes). A string
-- that does not hold a JSON object is left as it is: there is nothing to
-- recover from it, and the readers treat it as empty settings. Idempotent:
-- on a second run no row is a string that holds an object.
do $$
declare
  pass int := 0;
  changed int;
begin
  loop
    -- The string holds an object, or another string (wrapped twice).
    update libraries
       set settings = (settings #>> '{}')::jsonb
     where jsonb_typeof(settings) = 'string'
       and ((settings #>> '{}') is json object
            or ((settings #>> '{}') is json scalar and ltrim(settings #>> '{}') like '"%'));
    get diagnostics changed = row_count;
    pass := pass + 1;
    exit when changed = 0 or pass >= 5;
  end loop;
end $$;
