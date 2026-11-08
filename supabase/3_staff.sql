-- =========================================================
-- 유실물 e음 · 3단계: 기관 담당자 계정 연결
-- 1) 대시보드 > Authentication > Users > Add user > Create new user
--    (이메일·비밀번호 입력, "Auto Confirm User" 체크)
-- 2) 아래 이메일을 방금 만든 계정으로 바꾸고 Run.
-- =========================================================

insert into public.staff_members (user_id, org_id, display_name)
select u.id, o.id, '시청 유실물센터 담당자'
from auth.users u, public.orgs o
where u.email = 'staff@example.com'      -- ← 만든 계정 이메일
  and o.name  = '시청 유실물센터';        -- ← 담당할 기관

-- 확인: 한 줄이 나오면 성공
select s.display_name, o.name as org, u.email
from public.staff_members s join public.orgs o on o.id = s.org_id join auth.users u on u.id = s.user_id;
