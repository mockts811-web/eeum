<!-- 고현 수정 시작: 사진 자동 분석 최종 작업 요약과 GitHub 인계 -->

**최종 동작**

기존 외부 습득물과 새로 수집되는 물품의 사진을 기존 ai-parse로 자동 분석하고, 허용한 외형 특징을 공개 description에 자동 추가합니다. 담당자의 사진 보강/저장 클릭은 필요하지 않습니다. 습득/보관 상투 문구는 제거하고 물품명·색상·실질적인 설명은 유지합니다.

실제 확인 예: 카드지갑(TOMMY HILFIGER)(블랙(검정)색), 접이식, 가죽 재질.

- 같은 사진의 유효한 Storage ETag가 유지되면 재업로드돼도 재분석하지 않습니다.
- 개인정보 의심 결과·이름/번호·지원하지 않는 문구는 자동 공개하지 않습니다.
- 일시 오류는 제한 재시도하고 공개 저장 실패는 캐시로 저장만 재시도합니다.
- 분당 최대 1작업, 일일 최대 300작업입니다. 전체 사진은 순차 처리하며 모두 완료됐다는 뜻은 아닙니다.
- 기존 문장 958건의 상투 문구를 정리했습니다. 원문은 비공개 description_formats/publications에 보관하고 조건부로 복구합니다.
- 로컬 40개 검사를 통과했고 실제 AI 분석→공개 저장, 문장 정리, 원문 보관을 운영에서 확인했습니다.

**적용 상태와 브랜치**

Supabase에는 이미 적용했습니다. GitHub 업로드는 소스 보관 작업이며 설치 SQL을 다시 실행하거나 기존 AI/수집 함수를 재배포할 필요가 없습니다. 기존 ai-parse v46, 수집기 v56, 작업자 auto-analyze-items v2를 재사용합니다.

작업 브랜치는 feature/dugong입니다. 참조 main ce888cb1a7fc4bf8474157bd711601f638c7fbed는 변경하지 않았습니다. 원격 feature/dugong이 main보다 77개 커밋 뒤에 있어, 로컬 feature/dugong만 해당 main까지 fast-forward한 뒤 작업했습니다. 최종 main 대비 변경은 새 파일 추가이며, index.html·기존 ai-parse·수집기 파일을 덮어쓰지 않습니다.

**GitHub 웹에서 직접 반영하는 방법**

1. mockts811-web/eeum에서 feature/dugong을 선택합니다.
2. 이번 작업은 feature/dugong에 새 파일을 업로드하는 것까지만 진행합니다. PR 생성·브랜치 병합은 진행하지 않으며, main에 합치는 작업은 다른 담당자가 추후 진행합니다.
3. feature/dugong 저장소 루트에서 Add file → Upload files를 누릅니다. 최종 업로드 ZIP을 압축 해제한 뒤 루트의 supabase, scripts, tests, audit 폴더 4개를 함께 끌어 넣습니다. ZIP에는 새 파일만 포함하며 기존 index.html·AI 함수·수집기·README는 포함하지 않습니다. 폴더 구조를 유지하고 ZIP 파일 자체는 업로드하지 않습니다.

```text
supabase/functions/_shared/photo-analysis.ts
supabase/functions/auto-analyze-items/handler.ts
supabase/functions/auto-analyze-items/index.ts
supabase/photo-ai/                         # 이 폴더의 SQL·문서·editor 파일 전체
scripts/build-photo-ai.mjs
tests/photo-ai.test.cjs
```

4. 최초 비교 근거도 보관하려면 audit/photo-ai/ 폴더를 함께 추가합니다. 이는 최초 분석 시점 기록이며 현재 적용 상태는 DEPLOYMENT.ko.md를 기준으로 확인합니다.
5. Commit directly to feature/dugong을 선택하고 아래 메시지로 커밋합니다. 이번 인계는 이 단계에서 마칩니다.

```text
feat: 기존·신규 사진 자동 분석 및 공개 특징 보강
```

프런트엔드 index.html은 편집할 필요가 없습니다. GitHub 업로드 여부와 관계없이 현재 Supabase의 자동화는 동작합니다.

**관련 자료**

- APPLY.ko.md: 신규 설치/확인/중지/복구 순서
- DEPLOYMENT.ko.md: 운영 적용 기록과 검증 사례
- SECOND_REVIEW.ko.md: 로직·엣지 케이스·보안·Dry Run 검증 및 한계
- 90_pause.sql: 새 자동화 중지
- 93_restore_public_features.sql: 사진 특징 추가와 문장 정리를 역순 조건부 복구

<!-- 고현 수정 끝: 사진 자동 분석 최종 작업 요약과 GitHub 인계 -->
