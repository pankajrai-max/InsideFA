// =====================================================================
//  db.js — the bridge between your app and the Supabase backend.
//  This replaces the in-memory arrays in the demo with real, shared data.
//
//  HOW TO USE:
//   1. Put your project's URL and anon key below (Supabase → Settings → API).
//   2. In your HTML, load this as a module:  <script type="module" src="db.js">
//      or import the functions you need.
//
//  SAFE TO SHIP: the "anon key" is meant to live in the browser. The
//  security rules in schema.sql (RLS) are what protect your data.
//  NEVER put the "service_role" key here — that one bypasses security.
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ymodtupjmvziwbwjolgj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inltb2R0dXBqbXZ6aXdid2pvbGdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyODg3ODksImV4cCI6MjA5Nzg2NDc4OX0.fiTnksEirMk5VZ0GJQaEitLQf6ijYAqV6L-mcYzn7pU';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


// ---------------------------------------------------------------------
//  AUTH — passwordless login by email link (best for staff: nothing to
//  remember, and you can lock signups to your company domain in the
//  Supabase dashboard → Authentication → Providers).
// ---------------------------------------------------------------------
export async function signIn(email) {
  const { error } = await db.auth.signInWithOtp({ email });
  return error;                 // null = a magic link was emailed
}
export async function signOut()      { await db.auth.signOut(); }
export async function currentUser()  { const { data } = await db.auth.getUser(); return data.user; }


// ---------------------------------------------------------------------
//  FEED
// ---------------------------------------------------------------------
export async function getFeed() {
  // pull posts + author + comments + likes in one query
  const { data } = await db.from('posts')
    .select('*, author:profiles(name,initials,color,department), comments(text,author:profiles(name)), post_likes(user_id)')
    .order('created_at', { ascending: false });
  return data ?? [];
}
export async function addPost(text, mediaEmoji = null) {
  const user = await currentUser();
  return db.from('posts').insert({ author_id: user.id, text, media_emoji: mediaEmoji });
}
export async function toggleLike(postId) {
  const user = await currentUser();
  const { data } = await db.from('post_likes')
    .select('post_id').eq('post_id', postId).eq('user_id', user.id).maybeSingle();
  if (data)  return db.from('post_likes').delete().eq('post_id', postId).eq('user_id', user.id);
  else       return db.from('post_likes').insert({ post_id: postId, user_id: user.id });
}
export async function addComment(postId, text) {
  const user = await currentUser();
  return db.from('comments').insert({ post_id: postId, author_id: user.id, text });
}
// live feed: runs your callback whenever anyone posts/likes/comments
export function watchFeed(onChange) {
  return db.channel('feed')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'post_likes' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, onChange)
    .subscribe();
}


// ---------------------------------------------------------------------
//  TUCK SHOP
// ---------------------------------------------------------------------
export async function getMenu() {
  const { data } = await db.from('menu_items').select('*').eq('available', true);
  return data ?? [];
}
// cart = [{ id, name, price, qty }, ...]
export async function placeOrder(cart) {
  const user  = await currentUser();
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const { data: order, error } = await db.from('orders')
    .insert({ user_id: user.id, total }).select().single();
  if (error) return { error };
  await db.from('order_items').insert(
    cart.map(i => ({ order_id: order.id, menu_item_id: i.id, name: i.name, qty: i.qty, price_each: i.price }))
  );
  return { order };             // status starts as 'placed'; shop marks it ready
}
// for the shop's screen: watch new orders come in live
export function watchOrders(onChange) {
  return db.channel('orders')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, onChange)
    .subscribe();
}
export async function setOrderStatus(orderId, status) {  // staff only (enforced by RLS)
  return db.from('orders').update({ status }).eq('id', orderId);
}


// ---------------------------------------------------------------------
//  OUTINGS
// ---------------------------------------------------------------------
export async function getOutings() {
  const { data } = await db.from('outings')
    .select('*, author:profiles(name,initials,color,department), outing_joins(user_id, profiles(initials,color))')
    .order('created_at', { ascending: false });
  return data ?? [];
}
export async function addOuting(text, pill) {
  const user = await currentUser();
  return db.from('outings').insert({ author_id: user.id, text, pill });
}
export async function toggleJoin(outingId) {
  const user = await currentUser();
  const { data } = await db.from('outing_joins')
    .select('outing_id').eq('outing_id', outingId).eq('user_id', user.id).maybeSingle();
  if (data) return db.from('outing_joins').delete().eq('outing_id', outingId).eq('user_id', user.id);
  else      return db.from('outing_joins').insert({ outing_id: outingId, user_id: user.id });
}


// ---------------------------------------------------------------------
//  GAMES (Connect Four — real two-player, two-device)
// ---------------------------------------------------------------------
// Find a game waiting for an opponent and join it; if none, create one.
export async function findOrCreateGame() {
  const user = await currentUser();
  const { data: open } = await db.from('games')
    .select('*').eq('status', 'waiting').neq('player1_id', user.id).limit(1).maybeSingle();

  if (open) {
    const { data } = await db.from('games')
      .update({ player2_id: user.id, status: 'playing' })
      .eq('id', open.id).select().single();
    return data;                // you are player 2 (yellow)
  }
  const { data } = await db.from('games')
    .insert({ player1_id: user.id, status: 'waiting' }).select().single();
  return data;                  // you are player 1 (red), waiting
}

// Drop a piece. Reads the current board, applies the move, checks for a
// win, and saves — both players see the update live via watchGame().
export async function dropPiece(game, col, me) {
  const board = game.board.map(r => [...r]);
  const player = game.player1_id === me ? 1 : 2;
  if (game.turn !== player) return game;                 // not your turn
  for (let r = 5; r >= 0; r--) {
    if (board[r][col] === 0) {
      board[r][col] = player;
      const won = checkWin(board, r, col, player);
      const update = {
        board,
        turn: player === 1 ? 2 : 1,
        status: won ? 'finished' : 'playing',
        winner_id: won ? me : null,
      };
      const { data } = await db.from('games').update(update).eq('id', game.id).select().single();
      return data;
    }
  }
  return game;                                            // column full
}

export function watchGame(gameId, onChange) {
  return db.channel('game:' + gameId)
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'games', filter: 'id=eq.' + gameId },
        payload => onChange(payload.new))
    .subscribe();
}

export async function getLeaderboard() {
  const { data } = await db.from('leaderboard').select('*').limit(10);
  return data ?? [];
}

// four-in-a-row check (horizontal, vertical, both diagonals)
function checkWin(b, r, c, p) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let n = 1;
    for (const s of [1, -1]) {
      let rr = r + dr*s, cc = c + dc*s;
      while (rr>=0 && rr<6 && cc>=0 && cc<7 && b[rr][cc]===p) { n++; rr+=dr*s; cc+=dc*s; }
    }
    if (n >= 4) return true;
  }
  return false;
}
