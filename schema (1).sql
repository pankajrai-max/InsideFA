-- =====================================================================
--  HIVE — database setup for Supabase (free tier)
--  Paste this whole file into Supabase → SQL Editor → Run.
--  Safe to run more than once: it cleans up before recreating.
-- =====================================================================

-- ---------- 1. PROFILES (one row per employee) -----------------------
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  department  text default 'Team',
  initials    text,
  color       text default '#6C4DF2',
  is_staff    boolean default false,
  created_at  timestamptz default now()
);

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, initials)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    upper(left(coalesce(new.raw_user_meta_data->>'name', new.email),2))
  );
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ---------- 2. FEED --------------------------------------------------
create table if not exists posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references profiles(id) on delete cascade,
  text        text not null,
  media_emoji text,
  created_at  timestamptz default now()
);

create table if not exists post_likes (
  post_id uuid references posts(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  primary key (post_id, user_id)
);

create table if not exists comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references posts(id) on delete cascade,
  author_id  uuid not null references profiles(id) on delete cascade,
  text       text not null,
  created_at timestamptz default now()
);


-- ---------- 3. TUCK SHOP --------------------------------------------
create table if not exists menu_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  price       integer not null,
  emoji       text,
  available   boolean default true
);

create table if not exists orders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  total      integer not null,
  status     text default 'placed'
             check (status in ('placed','preparing','ready','collected')),
  created_at timestamptz default now()
);

create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  menu_item_id uuid references menu_items(id),
  name         text,
  qty          integer not null,
  price_each   integer not null
);


-- ---------- 4. OUTINGS ----------------------------------------------
create table if not exists outings (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null references profiles(id) on delete cascade,
  pill       text,
  text       text not null,
  created_at timestamptz default now()
);

create table if not exists outing_joins (
  outing_id uuid references outings(id) on delete cascade,
  user_id   uuid references profiles(id) on delete cascade,
  primary key (outing_id, user_id)
);


-- ---------- 5. GAMES (turn-based, e.g. Connect Four) ----------------
create table if not exists games (
  id         uuid primary key default gen_random_uuid(),
  type       text default 'connect4',
  player1_id uuid not null references profiles(id),
  player2_id uuid references profiles(id),
  board      jsonb not null default '[[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0]]',
  turn       integer default 1,
  status     text default 'waiting'
             check (status in ('waiting','playing','finished')),
  winner_id  uuid references profiles(id),
  created_at timestamptz default now()
);

create or replace view leaderboard as
  select p.id, p.name, count(g.id) as wins
  from profiles p
  left join games g
    on g.winner_id = p.id and g.created_at > now() - interval '7 days'
  group by p.id, p.name
  order by wins desc;


-- =====================================================================
--  SECURITY (Row Level Security)
--  Logged-in employees can READ shared content, but only WRITE as
--  themselves. Orders stay private to you (and visible to staff).
-- =====================================================================

alter table profiles     enable row level security;
alter table posts        enable row level security;
alter table post_likes   enable row level security;
alter table comments     enable row level security;
alter table menu_items   enable row level security;
alter table orders       enable row level security;
alter table order_items  enable row level security;
alter table outings      enable row level security;
alter table outing_joins enable row level security;
alter table games        enable row level security;

-- profiles
drop policy if exists "read profiles" on profiles;
create policy "read profiles" on profiles for select to authenticated using (true);
drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles for update to authenticated using (auth.uid() = id);

-- posts
drop policy if exists "read posts" on posts;
create policy "read posts" on posts for select to authenticated using (true);
drop policy if exists "write posts" on posts;
create policy "write posts" on posts for insert to authenticated with check (auth.uid() = author_id);
drop policy if exists "edit own post" on posts;
create policy "edit own post" on posts for update to authenticated using (auth.uid() = author_id);
drop policy if exists "del own post" on posts;
create policy "del own post" on posts for delete to authenticated using (auth.uid() = author_id);

-- likes
drop policy if exists "read likes" on post_likes;
create policy "read likes" on post_likes for select to authenticated using (true);
drop policy if exists "add like" on post_likes;
create policy "add like" on post_likes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "remove like" on post_likes;
create policy "remove like" on post_likes for delete to authenticated using (auth.uid() = user_id);

-- comments
drop policy if exists "read comments" on comments;
create policy "read comments" on comments for select to authenticated using (true);
drop policy if exists "write comments" on comments;
create policy "write comments" on comments for insert to authenticated with check (auth.uid() = author_id);
drop policy if exists "del own comment" on comments;
create policy "del own comment" on comments for delete to authenticated using (auth.uid() = author_id);

-- menu: everyone reads, only staff change it
drop policy if exists "read menu" on menu_items;
create policy "read menu" on menu_items for select to authenticated using (true);
drop policy if exists "staff edit menu" on menu_items;
create policy "staff edit menu" on menu_items for all to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_staff));

-- orders: you see yours, staff see all
drop policy if exists "read own orders" on orders;
create policy "read own orders" on orders for select to authenticated
  using (auth.uid() = user_id or exists (select 1 from profiles where id = auth.uid() and is_staff));
drop policy if exists "place order" on orders;
create policy "place order" on orders for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "staff update order" on orders;
create policy "staff update order" on orders for update to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_staff));

-- order_items follow their order  (INSERT uses WITH CHECK only)
drop policy if exists "read order items" on order_items;
create policy "read order items" on order_items for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id
    and (o.user_id = auth.uid() or exists (select 1 from profiles where id = auth.uid() and is_staff))));
drop policy if exists "add order items" on order_items;
create policy "add order items" on order_items for insert to authenticated
  with check (exists (select 1 from orders o where o.id = order_id and o.user_id = auth.uid()));

-- outings
drop policy if exists "read outings" on outings;
create policy "read outings" on outings for select to authenticated using (true);
drop policy if exists "write outings" on outings;
create policy "write outings" on outings for insert to authenticated with check (auth.uid() = author_id);
drop policy if exists "del own outing" on outings;
create policy "del own outing" on outings for delete to authenticated using (auth.uid() = author_id);
drop policy if exists "read joins" on outing_joins;
create policy "read joins" on outing_joins for select to authenticated using (true);
drop policy if exists "join outing" on outing_joins;
create policy "join outing" on outing_joins for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "leave outing" on outing_joins;
create policy "leave outing" on outing_joins for delete to authenticated using (auth.uid() = user_id);

-- games: anyone reads & joins; only the two players can move
drop policy if exists "read games" on games;
create policy "read games" on games for select to authenticated using (true);
drop policy if exists "create game" on games;
create policy "create game" on games for insert to authenticated with check (auth.uid() = player1_id);
drop policy if exists "join/move game" on games;
create policy "join/move game" on games for update to authenticated
  using (auth.uid() = player1_id or auth.uid() = player2_id or player2_id is null);


-- =====================================================================
--  REALTIME — broadcast changes so the feed and game update live.
--  Wrapped so re-running won't error if already added.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['posts','comments','post_likes','outings','outing_joins','orders','games']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;


-- =====================================================================
--  SEED — load the tuck shop menu.
-- =====================================================================
insert into menu_items (name, description, price, emoji) values
  ('Masala chai',  'hot · 200ml',      15, '🍵'),
  ('Samosa',       '2 pieces',         30, '🥟'),
  ('Veg sandwich', 'grilled',          50, '🥪'),
  ('Cold coffee',  'chilled · 300ml',  60, '🥤'),
  ('Maggi',        'masala',           40, '🍜'),
  ('Brownie',      'fudgy',            45, '🍫')
on conflict do nothing;

-- Done. Your backend is live.
