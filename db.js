// =====================================================================
//  db.js — bridge between the app and Supabase.
//  Anon key is safe in the browser; the SQL security rules protect data.
//  NEVER put the service_role key here.
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ymodtupjmvziwbwjolgj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inltb2R0dXBqbXZ6aXdid2pvbGdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyODg3ODksImV4cCI6MjA5Nzg2NDc4OX0.fiTnksEirMk5VZ0GJQaEitLQf6ijYAqV6L-mcYzn7pU';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- AUTH ----------------------------------------------------
export const ALLOWED_DOMAINS = ['flick2know.com', 'fieldassist.com', 'fieldassist.in'];
export function emailAllowed(email) {
  return ALLOWED_DOMAINS.includes((email.split('@')[1] || '').toLowerCase());
}
export async function signInLink(email) {
  const { error } = await db.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
  return error;
}
export async function signInPassword(email, password) {
  const { error } = await db.auth.signInWithPassword({ email, password });
  return error;
}
export async function signOut()     { await db.auth.signOut(); }
export async function currentUser() { const { data } = await db.auth.getUser(); return data.user; }

const COLORS = ['#6C4DF2','#13C2A3','#FFB23E','#FF6B6B','#4A32C0','#0EA5E9'];
const inits = n => (n || '?').trim().slice(0,2).toUpperCase();
const colr  = n => COLORS[((n || '').charCodeAt(0) || 0) % COLORS.length];

// Make sure the logged-in user has a profile row (creates one if missing).
export async function ensureProfile(user) {
  let { data } = await db.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (!data) {
    const name = (user.email || 'user').split('@')[0];
    await db.from('profiles').upsert({ id: user.id, name, initials: inits(name), color: colr(name) });
    ({ data } = await db.from('profiles').select('*').eq('id', user.id).maybeSingle());
  }
  return data;
}
export async function updateProfile(fields) {
  const user = await currentUser();
  const { error } = await db.from('profiles').update(fields).eq('id', user.id);
  return error;
}
export async function uploadAvatar(file) {
  const user = await currentUser();
  const path = `${user.id}/${Date.now()}`;
  const { error } = await db.storage.from('avatars').upload(path, file, { upsert: true, contentType: file.type });
  if (error) return { error };
  const { data } = db.storage.from('avatars').getPublicUrl(path);
  return { url: data.publicUrl };
}

// ---------- FEED ----------------------------------------------------
export async function getFeed() {
  const { data } = await db.from('posts')
    .select('*, author:profiles(name,initials,color,department,avatar_url), comments(id,text,author:profiles(name)), post_likes(user_id)')
    .order('created_at', { ascending: false });
  return data ?? [];
}
export async function addPost(text, mediaEmoji = null) {
  const user = await currentUser();
  const { error } = await db.from('posts').insert({ author_id: user.id, text, media_emoji: mediaEmoji });
  return error;                          // null = success
}
export async function toggleLike(postId) {
  const user = await currentUser();
  const { data } = await db.from('post_likes').select('post_id').eq('post_id', postId).eq('user_id', user.id).maybeSingle();
  return data ? db.from('post_likes').delete().eq('post_id', postId).eq('user_id', user.id)
              : db.from('post_likes').insert({ post_id: postId, user_id: user.id });
}
export async function addComment(postId, text) {
  const user = await currentUser();
  const { error } = await db.from('comments').insert({ post_id: postId, author_id: user.id, text });
  return error;
}
export function watchFeed(onChange) {
  return db.channel('feed')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'post_likes' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, onChange)
    .subscribe();
}

// ---------- TUCK SHOP ----------------------------------------------
export async function getMenu() {
  const { data } = await db.from('menu_items').select('*').eq('available', true).order('name');
  return data ?? [];
}
export async function placeOrder(cart) {
  const user = await currentUser();
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const { data: order, error } = await db.from('orders').insert({ user_id: user.id, total }).select().single();
  if (error) return { error };
  await db.from('order_items').insert(cart.map(i => ({ order_id: order.id, menu_item_id: i.id, name: i.name, qty: i.qty, price_each: i.price })));
  return { order };
}

// ---------- OUTINGS -------------------------------------------------
export async function getOutings() {
  const { data } = await db.from('outings')
    .select('*, author:profiles(name,initials,color,department,avatar_url), outing_joins(user_id, profiles(initials,color,avatar_url))')
    .order('created_at', { ascending: false });
  return data ?? [];
}
export async function addOuting(text, pill) {
  const user = await currentUser();
  const { error } = await db.from('outings').insert({ author_id: user.id, text, pill });
  return error;
}
export async function toggleJoin(outingId) {
  const user = await currentUser();
  const { data } = await db.from('outing_joins').select('outing_id').eq('outing_id', outingId).eq('user_id', user.id).maybeSingle();
  return data ? db.from('outing_joins').delete().eq('outing_id', outingId).eq('user_id', user.id)
              : db.from('outing_joins').insert({ outing_id: outingId, user_id: user.id });
}

// ---------- GAMES (Connect Four + Tic-Tac-Toe, both live) ----------
function emptyBoard(type) {
  return type === 'ttt'
    ? [[0,0,0],[0,0,0],[0,0,0]]
    : [[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0]];
}
export async function findOrCreateGame(type = 'connect4') {
  const user = await currentUser();
  const { data: open } = await db.from('games')
    .select('*').eq('type', type).eq('status', 'waiting').neq('player1_id', user.id).limit(1).maybeSingle();
  if (open) {
    const { data } = await db.from('games').update({ player2_id: user.id, status: 'playing' }).eq('id', open.id).select().single();
    return data;
  }
  const { data } = await db.from('games')
    .insert({ type, player1_id: user.id, status: 'waiting', board: emptyBoard(type) }).select().single();
  return data;
}
export function watchGame(gameId, onChange) {
  return db.channel('game:' + gameId)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: 'id=eq.' + gameId }, p => onChange(p.new))
    .subscribe();
}
export async function dropConnect4(game, col, me) {
  const player = game.player1_id === me ? 1 : 2;
  if (game.turn !== player || game.status !== 'playing') return game;
  const board = game.board.map(r => [...r]);
  for (let r = 5; r >= 0; r--) {
    if (board[r][col] === 0) {
      board[r][col] = player;
      const won = win4(board, r, col, player);
      const upd = { board, turn: player === 1 ? 2 : 1, status: won ? 'finished' : 'playing', winner_id: won ? me : null };
      const { data } = await db.from('games').update(upd).eq('id', game.id).select().single();
      return data;
    }
  }
  return game;
}
export async function placeTTT(game, idx, me) {
  const player = game.player1_id === me ? 1 : 2;
  if (game.turn !== player || game.status !== 'playing') return game;
  const r = Math.floor(idx / 3), c = idx % 3;
  if (game.board[r][c] !== 0) return game;
  const board = game.board.map(x => [...x]);
  board[r][c] = player;
  const won = win3(board, player), full = board.flat().every(v => v !== 0);
  const upd = { board, turn: player === 1 ? 2 : 1, status: (won || full) ? 'finished' : 'playing', winner_id: won ? me : null };
  const { data } = await db.from('games').update(upd).eq('id', game.id).select().single();
  return data;
}
export async function getLeaderboard() { const { data } = await db.from('leaderboard').select('*').limit(10); return data ?? []; }
function win4(b, r, c, p) {
  for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
    let n = 1;
    for (const s of [1,-1]) { let rr=r+dr*s, cc=c+dc*s; while (rr>=0&&rr<6&&cc>=0&&cc<7&&b[rr][cc]===p){n++;rr+=dr*s;cc+=dc*s;} }
    if (n >= 4) return true;
  }
  return false;
}
function win3(b, p) {
  const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  const flat = b.flat();
  return L.some(line => line.every(i => flat[i] === p));
}

// ---------- ADMIN ---------------------------------------------------
export async function inviteUser(email) {
  if (!emailAllowed(email)) return { message: 'That email is not on an allowed company domain.' };
  return await signInLink(email);
}
export async function getOpenOrders() {
  const { data } = await db.from('orders')
    .select('*, user:profiles(name,initials,color), order_items(name,qty,price_each)')
    .neq('status', 'collected').order('created_at');
  return data ?? [];
}
export async function setOrderStatus(orderId, status) { return db.from('orders').update({ status }).eq('id', orderId); }
export function watchOrders(onChange) {
  return db.channel('orders-admin').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, onChange).subscribe();
}
export async function getAllUsers() {
  const { data } = await db.from('profiles').select('id,name,department,initials,color,avatar_url,is_staff,blocked').order('name');
  return data ?? [];
}
export async function setBlocked(userId, blocked) { return db.from('profiles').update({ blocked }).eq('id', userId); }
export async function removeUser(userId) {
  await db.from('posts').delete().eq('author_id', userId);
  await db.from('comments').delete().eq('author_id', userId);
  await db.from('outings').delete().eq('author_id', userId);
  return db.from('profiles').delete().eq('id', userId);
}
export async function deletePost(id)    { return db.from('posts').delete().eq('id', id); }
export async function deleteComment(id) { return db.from('comments').delete().eq('id', id); }
export async function deleteOuting(id)  { return db.from('outings').delete().eq('id', id); }
export async function getMenuAll() { const { data } = await db.from('menu_items').select('*').order('name'); return data ?? []; }
export async function addMenuItem(name, price, emoji, description) {
  return db.from('menu_items').insert({ name, price: parseInt(price) || 0, emoji: emoji || '🍽️', description: description || '' });
}
export async function setMenuAvailable(id, available) { return db.from('menu_items').update({ available }).eq('id', id); }
export async function deleteMenuItem(id) { return db.from('menu_items').delete().eq('id', id); }
