# 유실물 e음

대중교통(지하철·버스)과 경찰서에 맡겨진 습득물을 문장 하나로 찾는 AI 공공서비스 시범판입니다.
청년공공AX 서포터즈 에공 팀.

- 배포 주소: https://mockts811-web.github.io/eeum/
- 화면: `index.html` 한 파일 (시민 화면 + 기관 담당자 화면)
- 서버: Supabase (DB · 로그인 · 사진 저장소 · Edge Functions)

## 파일 구성

```
index.html                              화면 전체
supabase/
├─ 1_schema.sql                         표 · 권한 · 보안(RLS) · 사진 저장소
├─ 2_seed.sql                           시연용 기관 · 습득물
├─ 3_staff.sql                          담당자 계정 ↔ 기관 연결
├─ 4_cron.sql                           (준비 중) 알림 자동 실행 예약
└─ functions/
   ├─ ai-parse/index.ts                 문장 → 검색 조건, 메모 → 등록 항목 (Gemini)   고현 · 김다영
   ├─ transit-locate/index.ts           당일 분실: 실시간 열차·버스 위치로 탔던 차 추정   서유석
   └─ fetch-police-items/index.ts       경찰청 · 포털기관 습득물 API 수집 → items       김준희
```

## 기능별 담당 코드

| 기능 | 화면 | 서버 |
|---|---|---|
| 문장으로 습득물 찾기 (물건·노선 여러 개, 분류 11종) | `index.html` | `ai-parse` |
| 담당자 습득물 등록 (메모 → 항목 자동 정리, 개인정보 가림) | `index.html` | `ai-parse` |
| 당일 분실 실시간 위치 (지하철·서울/경기/인천 버스) | `index.html` | `transit-locate` |
| 실제 습득물 데이터 | — | `fetch-police-items` |
| 닮음 점수 = 0.45 유사도 + 0.20 색상 + 0.15 날짜 + 0.10 노선 + 0.10 분류 | `index.html` `score()` | — |

## 비밀 키

코드에는 키가 없습니다. 모두 **Supabase → Edge Functions → Secrets**에만 있습니다.

| 함수 | Secrets |
|---|---|
| ai-parse | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| transit-locate | `SEOUL_SUBWAY_KEY`, `SEOUL_BUS_KEY` |
| fetch-police-items | `POLICE_API_KEY`, `PORTAL_API_KEY`, `CRON_SECRET` |

`index.html`에 들어 있는 `sb_publishable_…` 키는 공개용 키라 노출돼도 됩니다. `secret` / `service_role` 키는 절대 HTML에 넣지 마세요.

## 내 Supabase로 새로 띄우기

1. **SQL Editor**에서 `1_schema.sql` → `2_seed.sql` 순서로 Run
2. **Authentication → Users → Add user**로 담당자 계정을 만들고, `3_staff.sql`의 이메일을 바꿔 Run
3. **Edge Functions → Deploy a new function → Via Editor**에 각 `index.ts`를 붙여넣고 Deploy (Verify JWT 끄기), 위 표의 Secrets 등록
4. `index.html`의 `CONFIG`에 Project URL과 Publishable key를 넣기

`CONFIG`를 비우면 시연용 가상 데이터로, Gemini 키가 없으면 규칙 기반 정리로, 실시간 위치 키가 없으면 시간표 기반 계산으로 동작합니다. 어느 경우에도 화면은 멈추지 않습니다.

## 보안 구조 (요약)

| 표 | 시민(로그인 없음) | 기관 담당자 |
|---|---|---|
| items | 수령 완료 전 물품 조회 | 자기 기관 물품 조회 · 등록 · 수정 |
| item_private (주인 확인 메모) | ✕ | 자기 기관 물품만 |
| pickups (수령 기록) | ✕ | 자기 기관 물품만 |
| alerts (알림 조건·이메일) | 등록만 (조회 ✕) | 등록만 |
| 사진 (item-photos) | 공개 URL로 보기 | 자기 기관 폴더에만 업로드 |

## 남은 작업

- 비슷한 물건 알림: 새 습득물과 알림 조건을 비교해 알려 주는 함수 (`4_cron.sql`이 이 함수를 예약함)
- 습득물 수집: 나눠서 이어 가져오기(`fetch_progress`)와 자동 수집 예약
- 경찰청 습득물 사진 주소 저장 · 표시
