<!-- 고현 수정 시작: 기존·신규 사진의 공개 특징 자동 보강 안내 -->

**기존·신규 외부 습득물 사진을 자동 분석해 공개 특징에 추가합니다.**

`사진 수집/기존 사진 대기 등록 → Cron → 기존 ai-parse → 결과 필터 → items.description 자동 저장`

담당자의 보강 버튼이나 저장 클릭 없이 반영합니다. 물품명·색상·실질적인 설명은 유지하고, 습득/보관 상투 문구를 정리한 뒤 안전한 외형 특징을 쉼표로 추가합니다. 원문은 비공개 description_formats/publications에 보관합니다. 개인정보 의심·알 수 없는 이름/번호·지원하지 않는 문구는 자동 공개하지 않습니다.

- [적용 순서](APPLY.ko.md)
- [실제 적용 기록](DEPLOYMENT.ko.md)
- [2차 검증 보고서](SECOND_REVIEW.ko.md)
- [공개 자동 저장 설치/업그레이드](08_public_features.sql)
- [기존 문장 정리 확장](09_tidy_public_descriptions.sql)
- [기존·신규 전체 활성화](07_enable_public_all.sql)
- [중지](90_pause.sql) / [공개 설명 복구](93_restore_public_features.sql)

기본 전체 처리 상한은 분당 1작업, 일일 300작업입니다. 같은 내용의 Storage ETag가 유지되면 수집기가 재업로드해도 재분석하지 않습니다. ETag가 없으면 객체 버전으로 판단합니다.

기존 ai-parse·수집기·프런트엔드는 변경하거나 재배포하지 않습니다. 사이트는 기존 description 조회로 새 특징을 표시하므로 GitHub 화면 수정이 선행 조건이 아닙니다. 작업은 feature/dugong에만 기록하고 main은 수정하지 않습니다.

05_enable_new_only.sql과 05_enable_all.sql은 이전 비공개 단계용입니다. 최종 공개 자동화는 08과 09 설치 후 07을 사용합니다. audit/photo-ai/는 최초 검토 시점의 기록입니다.

<!-- 고현 수정 끝: 기존·신규 사진의 공개 특징 자동 보강 안내 -->
