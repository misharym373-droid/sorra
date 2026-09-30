-- صُرة: تسجيل Apple Pay تلقائيًا بدون فتح الموقع (الصقه كامل في SQL Editor واضغط Run مرة وحدة)

-- رمز سري لكل مستخدم يستخدمه الاختصار
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

-- صندوق وارد للعمليات لين تفتح الموقع
create table if not exists public.ap_inbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount text not null,
  merchant text,
  created_at timestamptz not null default now()
);
alter table public.ap_inbox enable row level security;
drop policy if exists "ap_inbox_select_own" on public.ap_inbox;
drop policy if exists "ap_inbox_delete_own" on public.ap_inbox;
create policy "ap_inbox_select_own" on public.ap_inbox for select to authenticated using ((select auth.uid()) = user_id);
create policy "ap_inbox_delete_own" on public.ap_inbox for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.ap_inbox from anon;
grant select, delete on public.ap_inbox to authenticated;

-- الدالة اللي يناديها الاختصار: تتأكد من الرمز وتحفظ العملية فقط
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

-- ===== رسائل البنك (أضفه حتى لو شغّلت الجزء اللي فوق من قبل) =====
alter table public.ap_inbox add column if not exists raw text;

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
