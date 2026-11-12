-- Chronos durable memory on Postgres (Supabase).
-- Same model as the local SQLite store: one immutable, timestamped row per
-- message, a time index and a full-text index. The tables live in a schema
-- the REST API does not expose; the app reaches them only through the
-- chronos_* functions below, each of which requires the app's memory token.
--
-- After running this file, store the SHA-256 of a long random token:
--   insert into chronos.settings (token_sha256)
--   values (encode(sha256('<token>'::bytea), 'hex'));

create schema if not exists chronos;
revoke all on schema chronos from public, anon, authenticated;

create table if not exists chronos.messages (
    id         bigint generated always as identity primary key,
    user_id    text not null default 'legacy',
    session_id text not null,
    role       text not null check (role in ('user', 'assistant')),
    content    text not null,
    created_at timestamptz not null,
    meta       jsonb,
    fts        tsvector generated always as (to_tsvector('english', content)) stored
);
alter table chronos.messages add column if not exists user_id text not null default 'legacy';
create index if not exists messages_user_session_idx on chronos.messages (user_id, session_id, id);
create index if not exists messages_user_created_idx on chronos.messages (user_id, created_at);
create index if not exists messages_fts_idx on chronos.messages using gin (fts);

-- One row: the SHA-256 of the token the app must present.
create table if not exists chronos.settings (
    id           boolean primary key default true check (id),
    token_sha256 text not null
);

alter table chronos.messages enable row level security;
alter table chronos.settings enable row level security;

create or replace function chronos.reject_update() returns trigger
language plpgsql set search_path = '' as $$
begin
    raise exception 'messages are immutable';
end $$;

drop trigger if exists messages_immutable on chronos.messages;
create trigger messages_immutable before update on chronos.messages
    for each row execute function chronos.reject_update();

create or replace function chronos.check_token(p_token text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
    if not exists (
        select 1 from chronos.settings s
        where s.token_sha256 = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    ) then
        raise exception 'invalid memory token' using errcode = '28000';
    end if;
end $$;

create or replace function chronos.row_json(m chronos.messages) returns jsonb
language sql stable set search_path = '' as $$
    select jsonb_build_object(
        'id', m.id, 'user_id', m.user_id, 'session_id', m.session_id, 'role', m.role, 'content', m.content,
        'created_at', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'meta', m.meta
    )
$$;

-- Earlier single-user signatures.
drop function if exists public.chronos_save(text, text, text, text, timestamptz, jsonb);
drop function if exists public.chronos_begin_turn(text, text, text, timestamptz, int, timestamptz, timestamptz, text[], int);
drop function if exists public.chronos_history(text, text, int);

create or replace function public.chronos_save(
    p_token text, p_user_id text, p_session_id text, p_role text, p_content text,
    p_created_at timestamptz, p_meta jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    r chronos.messages;
begin
    perform chronos.check_token(p_token);
    insert into chronos.messages (user_id, session_id, role, content, created_at, meta)
    values (p_user_id, p_session_id, p_role, p_content, date_trunc('milliseconds', p_created_at), p_meta)
    returning * into r;
    return chronos.row_json(r);
end $$;

-- Stores the user's message and returns everything the turn needs from
-- memory in a single round trip.
create or replace function public.chronos_begin_turn(
    p_token text, p_user_id text, p_session_id text, p_content text, p_created_at timestamptz,
    p_window int, p_start timestamptz default null, p_end timestamptz default null,
    p_terms text[] default null, p_log_limit int default 0
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    r chronos.messages;
    q tsquery;
    tq tsquery;
    t text;
    v_recent jsonb;
    v_range jsonb := '[]'::jsonb;
    v_total bigint := 0;
    v_hits jsonb := '[]'::jsonb;
    v_log jsonb := '[]'::jsonb;
begin
    perform chronos.check_token(p_token);
    insert into chronos.messages (user_id, session_id, role, content, created_at)
    values (p_user_id, p_session_id, 'user', p_content, date_trunc('milliseconds', p_created_at))
    returning * into r;

    select coalesce(jsonb_agg(chronos.row_json(m) order by m.id), '[]'::jsonb) into v_recent
    from (select * from chronos.messages
          where user_id = p_user_id and session_id = p_session_id and id < r.id
          order by id desc limit greatest(p_window, 0)) m;

    if p_start is not null and p_end is not null then
        select count(*) into v_total from chronos.messages
        where user_id = p_user_id and created_at >= p_start and created_at < p_end and id <> r.id;
        select coalesce(jsonb_agg(chronos.row_json(m) order by m.created_at, m.id), '[]'::jsonb) into v_range
        from (select * from chronos.messages
              where user_id = p_user_id and created_at >= p_start and created_at < p_end and id <> r.id
              order by created_at, id limit 40) m;
    end if;

    if p_terms is not null then
        foreach t in array p_terms loop
            tq := plainto_tsquery('english', t);
            if numnode(tq) > 0 then
                q := case when q is null then tq else q || tq end;
            end if;
        end loop;
        if q is not null then
            -- Keyword matches, completed into exchanges: a matched question
            -- brings its answer and a matched answer brings its question.
            with matched as (
                select * from chronos.messages
                where user_id = p_user_id and fts @@ q and id <> r.id
                order by ts_rank(fts, q) desc, id desc limit 8
            ), partners as (
                select p.* from matched m
                cross join lateral (
                    select * from chronos.messages x
                    where x.user_id = p_user_id and x.session_id = m.session_id and x.id <> r.id
                      and ((m.role = 'user' and x.id > m.id) or (m.role = 'assistant' and x.id < m.id))
                    order by case when m.role = 'user' then x.id else -x.id end
                    limit 1
                ) p
                where p.role <> m.role
            ), turns as (
                select * from matched union select * from partners
            )
            select coalesce(jsonb_agg(chronos.row_json(m) order by m.id), '[]'::jsonb) into v_hits from turns m;
        end if;
    end if;

    if p_log_limit > 0 then
        select coalesce(jsonb_agg(chronos.row_json(m) order by m.id), '[]'::jsonb) into v_log
        from (select * from chronos.messages
              where user_id = p_user_id and session_id = p_session_id and role = 'user' and id <> r.id
              order by id desc limit p_log_limit) m;
    end if;

    return jsonb_build_object(
        'user', chronos.row_json(r), 'recent', v_recent, 'range_rows', v_range,
        'range_total', v_total, 'hits', v_hits, 'log', v_log
    );
end $$;

create or replace function public.chronos_history(p_token text, p_user_id text, p_session_id text, p_limit int default 500)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
    v jsonb;
begin
    perform chronos.check_token(p_token);
    select coalesce(jsonb_agg(chronos.row_json(m) order by m.id), '[]'::jsonb) into v
    from (select * from chronos.messages where user_id = p_user_id and session_id = p_session_id
          order by id desc limit greatest(p_limit, 0)) m;
    return v;
end $$;

revoke execute on all functions in schema chronos from public, anon, authenticated;
revoke execute on function public.chronos_save(text, text, text, text, text, timestamptz, jsonb) from public, authenticated;
revoke execute on function public.chronos_begin_turn(text, text, text, text, timestamptz, int, timestamptz, timestamptz, text[], int) from public, authenticated;
revoke execute on function public.chronos_history(text, text, text, int) from public, authenticated;
grant execute on function public.chronos_save(text, text, text, text, text, timestamptz, jsonb) to anon;
grant execute on function public.chronos_begin_turn(text, text, text, text, timestamptz, int, timestamptz, timestamptz, text[], int) to anon;
grant execute on function public.chronos_history(text, text, text, int) to anon;
