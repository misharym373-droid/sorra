-- =====================================================================
-- صُرة — إعداد Supabase الكامل (الصقه كامل في SQL Editor واضغط Run)
-- آمن تشغّله أكثر من مرة: ما يمسح أي بيانات.
-- يشمل: بيانات المستخدم + الحماية (RLS) + التسجيل التلقائي (Apple Pay ورسائل البنك)
-- =====================================================================

-- 1) بيانات كل مستخدم (صف واحد لكل مستخدم)
create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_data enable row level security;
drop policy if exists "user_data_select_own" on public.user_data;
drop policy if exists "user_data_insert_own" on public.user_data;
drop policy if exists "user_data_update_own" on public.user_data;
drop policy if exists "user_data_delete_own" on public.user_data;
create policy "user_data_select_own" on public.user_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "user_data_insert_own" on public.user_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "user_data_update_own" on public.user_data for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "user_data_delete_own" on public.user_data for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.user_data from anon;
grant select, insert, update, delete on public.user_data to authenticated;

-- 2) رمز سري لكل مستخدم يستخدمه اختصار الآيفون (يسمح بالإضافة فقط، لا يقرأ أي بيانات)
create table if not exists public.ap_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text unique not null,
  created_at timestamptz not null default now()
);
alter table public.ap_tokens enable row level security;
drop policy if exists "ap_tokens_own" on public.ap_tokens;
create policy "ap_tokens_own" on public.ap_tokens for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.ap_tokens from anon;
grant select, insert, update, delete on public.ap_tokens to authenticated;

-- 3) صندوق وارد مؤقت للعمليات لين يفتح المستخدم الموقع (ينحذف بعد الاستيراد)
create table if not exists public.ap_inbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount text not null,
  merchant text,
  raw text,
  created_at timestamptz not null default now()
);
alter table public.ap_inbox add column if not exists raw text;
create index if not exists ap_inbox_user_idx on public.ap_inbox (user_id, id);
alter table public.ap_inbox enable row level security;
drop policy if exists "ap_inbox_select_own" on public.ap_inbox;
drop policy if exists "ap_inbox_delete_own" on public.ap_inbox;
create policy "ap_inbox_select_own" on public.ap_inbox for select to authenticated using ((select auth.uid()) = user_id);
create policy "ap_inbox_delete_own" on public.ap_inbox for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.ap_inbox from anon;
grant select, delete on public.ap_inbox to authenticated;

-- 4) الدوال اللي يناديها الاختصار (بالمفتاح العام + رمز المستخدم)، مع حد للطلبات
create or replace function public.ap_push(p_token text, p_amount text, p_merchant text default '')
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  if p_token is null or length(p_token) < 24 then return 'bad token'; end if;
  select user_id into uid from public.ap_tokens where token = p_token;
  if uid is null then return 'bad token'; end if;
  if (select count(*) from public.ap_inbox where user_id = uid and created_at > now() - interval '1 minute') >= 20 then
    return 'rate limited';
  end if;
  insert into public.ap_inbox (user_id, amount, merchant)
  values (uid, left(coalesce(p_amount, ''), 40), left(coalesce(p_merchant, ''), 80));
  return 'ok';
end $$;
revoke all on function public.ap_push(text, text, text) from public;
grant execute on function public.ap_push(text, text, text) to anon, authenticated;

create or replace function public.ap_push_sms(p_token text, p_text text)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  if p_token is null or length(p_token) < 24 then return 'bad token'; end if;
  select user_id into uid from public.ap_tokens where token = p_token;
  if uid is null then return 'bad token'; end if;
  if (select count(*) from public.ap_inbox where user_id = uid and created_at > now() - interval '1 minute') >= 20 then
    return 'rate limited';
  end if;
  insert into public.ap_inbox (user_id, amount, merchant, raw)
  values (uid, '', 'sms', left(coalesce(p_text, ''), 600));
  return 'ok';
end $$;
revoke all on function public.ap_push_sms(text, text) from public;
grant execute on function public.ap_push_sms(text, text) to anon, authenticated;
