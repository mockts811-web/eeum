-- =========================================================
-- 유실물 e음 · 1단계: 테이블 · 권한 · 보안(RLS) · 사진 저장소
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run.
-- =========================================================

-- ---------- 테이블 ----------

-- 보관 기관 (유실물센터 · 운수회사 · 경찰서)
create table public.orgs (
  id        bigint generated always as identity primary key,
  name      text not null unique,
  kind      text not null check (kind in ('지하철', '버스', '경찰서')),
  tel       text,
  hours     text,
  lines     text,
  delivery  boolean not null default false
);

-- 기관 담당자 (로그인 계정 ↔ 소속 기관)
-- 권한은 이 표로 판단함 (사용자가 직접 바꿀 수 있는 user_metadata는 쓰지 않음)
create table public.staff_members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  org_id       bigint not null references public.orgs (id),
  display_name text
);
create index staff_members_org_id_idx on public.staff_members (org_id);

-- 습득물 (시민에게 공개되는 정보)
create table public.items (
  id            text primary key,                 -- 관리번호 (예: F2026102400012)
  kind          text not null check (kind in ('지하철', '버스', '경찰서')),
  name          text not null,
  category      text not null,
  sub_category  text,
  color         text,
  found_on      date not null,
  line          text,
  found_place   text,
  org_id        bigint not null references public.orgs (id),
  description   text,                             -- 공개 특징 (검색어)
  photo_path    text,                             -- item-photos 버킷 안의 경로
  valuable      boolean not null default false,   -- 고액·귀중품
  status        text not null default '보관중' check (status in ('보관중', '경찰서이관', '수령완료')),
  created_by    uuid references auth.users (id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index items_org_id_idx   on public.items (org_id);
create index items_found_on_idx on public.items (found_on desc) where status <> '수령완료';
create index items_created_idx  on public.items (created_at);

-- 주인 확인용 비공개 메모 (담당자만 볼 수 있게 표를 분리)
create table public.item_private (
  item_id           text primary key references public.items (id) on delete cascade,
  owner_check_memo  text
);

-- 수령 기록
create table public.pickups (
  id               bigint generated always as identity primary key,
  item_id          text not null references public.items (id),
  checked_id       boolean not null default false,
  checked_feature  boolean not null default false,
  proxy            boolean not null default false,
  proxy_doc        boolean not null default false,
  note             text,
  handled_by       uuid references auth.users (id) default auth.uid(),
  picked_up_at     timestamptz not null default now()
);
create index pickups_item_id_idx on public.pickups (item_id);

-- 비슷한 물건 알림 조건 (id는 브라우저가 만든 무작위 값 → 해지 열쇠로 씀)
create table public.alerts (
  id              uuid primary key,
  label           text not null,
  conditions      jsonb not null,
  email           text,
  email_consent   boolean not null default false,
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  constraint alerts_email_needs_consent check (email is null or email_consent)
);

-- 알림 발송 기록 (같은 물건을 두 번 알리지 않게)
create table public.alert_hits (
  alert_id    uuid not null references public.alerts (id) on delete cascade,
  item_id     text not null references public.items (id) on delete cascade,
  score       numeric(4, 2) not null,
  notified_at timestamptz not null default now(),
  primary key (alert_id, item_id)
);
create index alert_hits_item_id_idx on public.alert_hits (item_id);

-- updated_at 자동 갱신
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();

-- ---------- 보안: RLS 켜기 ----------
alter table public.orgs          enable row level security;
alter table public.staff_members enable row level security;
alter table public.items         enable row level security;
alter table public.item_private  enable row level security;
alter table public.pickups       enable row level security;
alter table public.alerts        enable row level security;
alter table public.alert_hits    enable row level security;

-- 기관 목록: 누구나 조회
create policy "기관 목록 공개" on public.orgs for select
  to anon, authenticated using (true);

-- 담당자: 자기 소속 정보만 조회
create policy "본인 소속 조회" on public.staff_members for select
  to authenticated using (user_id = (select auth.uid()));

-- 습득물: 시민은 수령 완료 전 물품만, 담당자는 자기 기관 물품 전부
create policy "습득물 공개 조회" on public.items for select
  to anon, authenticated using (status <> '수령완료');
create policy "담당자 자기 기관 조회" on public.items for select
  to authenticated using (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.org_id = items.org_id));
create policy "담당자 등록" on public.items for insert
  to authenticated with check (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.org_id = items.org_id));
create policy "담당자 수정" on public.items for update
  to authenticated
  using (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.org_id = items.org_id))
  with check (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.org_id = items.org_id));

-- #김다영 수정: 담당자가 자기 기관 물품 삭제 (수령 기록이 있으면 pickups 외래키 때문에 삭제되지 않음)
create policy "담당자 삭제" on public.items for delete
  to authenticated
  using (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.org_id = items.org_id));

-- 비공개 메모 · 수령 기록: 그 물품을 가진 기관 담당자만
create policy "담당자 비공개 메모" on public.item_private for all
  to authenticated
  using (exists (
    select 1 from public.items i join public.staff_members s on s.org_id = i.org_id
    where i.id = item_private.item_id and s.user_id = (select auth.uid())))
  with check (exists (
    select 1 from public.items i join public.staff_members s on s.org_id = i.org_id
    where i.id = item_private.item_id and s.user_id = (select auth.uid())));

create policy "담당자 수령 기록 조회" on public.pickups for select
  to authenticated using (exists (
    select 1 from public.items i join public.staff_members s on s.org_id = i.org_id
    where i.id = pickups.item_id and s.user_id = (select auth.uid())));
create policy "담당자 수령 기록 추가" on public.pickups for insert
  to authenticated with check (exists (
    select 1 from public.items i join public.staff_members s on s.org_id = i.org_id
    where i.id = pickups.item_id and s.user_id = (select auth.uid())));

-- 알림 조건: 누구나 등록만 가능 (다른 사람 조건·이메일은 조회 불가)
create policy "알림 등록" on public.alerts for insert
  to anon, authenticated with check (char_length(label) <= 200);
-- alert_hits: 정책 없음 → 서버 함수(service_role)만 사용

-- 알림 해지: 무작위 id를 아는 사람만 지울 수 있음
create function public.cancel_alert(p_id uuid) returns boolean
language sql security definer set search_path = '' as $$
  with d as (delete from public.alerts where id = p_id returning 1)
  select exists (select 1 from d);
$$;
revoke execute on function public.cancel_alert(uuid) from public;
grant execute on function public.cancel_alert(uuid) to anon, authenticated;

-- ---------- 권한 (Data API에 공개할 표만 명시적으로 열기) ----------
-- 2026-10-30부터 새 표는 자동 공개되지 않으므로 grant가 꼭 필요함
grant select                 on public.orgs          to anon, authenticated;
grant select                 on public.items         to anon, authenticated;
grant insert, update         on public.items         to authenticated;
grant select                 on public.staff_members to authenticated;
grant select, insert, update on public.item_private  to authenticated;
grant select, insert         on public.pickups       to authenticated;
grant insert                 on public.alerts        to anon, authenticated;
grant select, insert, update, delete
  on public.orgs, public.staff_members, public.items, public.item_private,
     public.pickups, public.alerts, public.alert_hits
  to service_role;

-- ---------- 사진 저장소 ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

-- 담당자만 자기 기관 폴더(<org_id>/...)에 올릴 수 있음. 보기는 공개 URL로.
create policy "담당자 사진 업로드" on storage.objects for insert
  to authenticated with check (
    bucket_id = 'item-photos'
    and (storage.foldername(name))[1] in (
      select s.org_id::text from public.staff_members s where s.user_id = (select auth.uid())));

-- #김다영 수정: 담당자가 자기 기관 폴더의 사진 삭제 (물품을 지울 때 사진도 같이 지움)
create policy "담당자 사진 삭제" on storage.objects for delete
  to authenticated using (
    bucket_id = 'item-photos'
    and (storage.foldername(name))[1] in (
      select s.org_id::text from public.staff_members s where s.user_id = (select auth.uid())));
