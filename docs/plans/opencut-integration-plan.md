# OpenCut 통합 계획 (웹 에디터 고도화)

> 2026-07-15 조사 · 2026-07-16 갱신. 결론: **통포크 금지, `opencut-classic`에서 부품 패턴만 발췌.**
>
> ✅ **Phase 1 구현 완료 (2026-07-16, 커밋 `201dd54` "feat(editor+channels): 검수 에디터 직접조작·저장").**
> 단, 계획했던 벤더링(코드 복사 격리)이 아니라 **네이티브 재구현**으로 실행됐다 — 아래 "이식 계획"·"작업 규칙" 참고.
>
> ⚠️ **소싱 기준 정정:** 발췌 기준은 main의 v0.3.0 태그가 아니라 **아카이브 저장소 `opencut-app/opencut-classic`**(2026-05-17 아카이브, MIT)로 고정한다. [step-d-master-build-plan.md](step-d-master-build-plan.md) §7.2가 정본.

## 조사 결과

| 항목 | 내용 |
|------|------|
| 라이선스 | **MIT** — 상용 SaaS 임베드·수정 자유, 저작권 고지만 유지 |
| 규모·활동 | 50.2k stars, 1,565 커밋, 최신 릴리스 v0.3.0 (2026-04) — 활발 |
| ⚠️ 핵심 반전 | **main 브랜치는 전면 재작성 중** — 에디터 코드가 제거된 빈 스캐폴드(Vite+TanStack Router, shadcn UI만 존재). 비즈니스 로직을 Rust(GPU 컴포지터, WASM)로 이전하는 중 |
| 안정 코드 | ~~v0.3.0 태그~~ → **`opencut-app/opencut-classic` 아카이브 저장소** (2026-05-17 아카이브, MIT) — Next.js App Router, 에디터 컴포넌트 ~12,300 LOC. 아카이브라 업스트림 픽스 없음 = 가져온 것은 우리가 소유·관리 |
| 아키텍처 성격 | 로컬 우선(파일이 기기에, IndexedDB 저장, 브라우저 내 렌더) — **우리(서버 미디어 GCS + 서버 ffmpeg 렌더)와 정반대** |

## 왜 통포크가 아닌가

1. main이 Vite+Rust로 전혀 다른 프로젝트가 돼 포크해도 업스트림 추적이 무의미. ("재작성 완료 후 재평가"도 무의미해져 폐기 — classic 아카이브 고정으로 대체.)
2. 로컬 우선 모델이 우리 B2B 모델과 상충 — 방송 마스터를 브라우저에 내려받게 할 수 없음.
3. `opencut-wasm` GPU 컴포지터 의존 — 우리는 프리뷰를 `<video>` + 오버레이로, 최종 화질은 서버 렌더로 해결하므로 불필요한 복잡도.
4. 우리 레포에 이미 에디터 골격 존재 (`apps/web/src/components/editor/`: editor-shell·timeline·preview·panel) — 갈아엎을 이유 없음.

## 이식 계획

### Phase 1 — 검수 에디터 완성 ✅ 구현 완료 (2026-07-16, 커밋 `201dd54`)

기존 우리 에디터 골격 유지. **코드 발췌 없이 OpenCut의 UI 패턴만 참고해 자체 작성**했다 (`apps/web/src/components/editor/`):

| 계획했던 OpenCut 부품 | 실제 구현 (전부 네이티브) |
|------|------|
| `panels/timeline/audio-waveform.tsx` | `editor-waveform.tsx` — `useAudioPeaks`(Web Audio로 클라이언트에서 오디오 디코드→다운샘플 피크) + `Waveform` 캔버스. 리트림 시 발화 경계를 눈으로 확인. 전체 파일을 fetch해 디코드하므로 **채택된 짧은 클립 전용** — 회차 마스터 규모는 서버측 peaks 엔드포인트가 후속 과제 |
| `components/editable-timecode.tsx` | `editable-timecode.tsx` — `TimecodeInput`(m:ss.d 직접 입력, blur/Enter 커밋, Esc·파싱 실패 시 되돌림). 타임라인 IN/OUT에 배선 |
| `drag-line.tsx`, `drop-target.ts` | 별도 이식 없음 — 프리뷰 오버레이 `Movable`의 드래그+중앙 스냅으로 흡수. **타임라인 트림 핸들의 발화 경계 자동 스냅은 미구현**(슬라이더+타임코드 입력+웨이브폼 시각 확인까지) |
| `text-edit-overlay.tsx`, `transform-handles.tsx`, `snap-guides.tsx` | `editor-overlay.tsx` — `Movable`(퍼센트 좌표 드래그·리사이즈 핸들), `SnapGuides`(중앙 정렬 가이드), `InlineText`(더블클릭 인라인 텍스트 편집) |

우리 것으로 대체한 부분 (실제 확정된 표면):

- 미디어 소스: 기존 `/api/media/:id/stream` (HTTP Range 스트리밍) — 계획대로.
- 상태·저장: 선언적 `EditorState` 통짜 직렬화(`apps/web/src/lib/editor/presets.ts`) → `store.tsx`의 `saveClipEditor` → 서버 `PATCH /api/clips/:id/editor`(`apps/server/src/index.ts`)가 클립 엔티티에 결정 블롭으로 저장. **저장 = 메타데이터만, 렌더 없음** (IndexedDB 프로젝트 스토어는 안 씀).
- 렌더: 서버 ffmpeg — 실제 9:16·자막 번인은 최종 익스포트 시 1회로 이연([step-d-master-build-plan.md](step-d-master-build-plan.md) §2.4 렌더 불변식). 브라우저 내 익스포트는 안 씀.
- 자막·오버레이 프리뷰: 퍼센트 좌표 CSS 오버레이로 근사 — "프리뷰는 근사치, 최종 화질은 서버 렌더"를 UI에 명시.

### Phase 2 — (조건부) 멀티트랙 타임라인 — 미착수

Phase 1 출시 후 편집 로그에서 "6개 조작 밖" 요구가 실측으로 확인될 때만:
- `opencut-classic`의 `panels/timeline/` 전체 이식 + zustand 스토어를 우리 데이터 모델로 감싸는 어댑터
- 그래도 컴포지터는 서버 렌더 유지. 그 이상이 필요하면 → 그건 프리미어 인계(XML/패널) 영역
- ⚠️ 게이팅 근거인 **편집 로그 계측이 아직 미구현**이라(아래 진행 현황 3) 판단 데이터가 없다.

## 작업 규칙

- **(현실 정정) 벤더 격리 규칙은 Phase 1에서 실행되지 않았다.** `apps/web/src/vendor/opencut/`도 NOTICE 파일도 없다 — 코드를 복사하지 않고 패턴만 참고해 자체 작성했으므로(`editable-timecode.tsx` 헤더: "implemented natively against our EditorState — no vendored code") MIT 고지 의무 자체가 발생하지 않았다.
- **(유지) 향후 `opencut-classic` 코드를 실제로 복사해 오는 경우**(Phase 2 멀티트랙 등)에만 원래 규칙 적용: `apps/web/src/vendor/opencut/` 격리 + 파일 상단 MIT 저작권 고지 + NOTICE에 출처 기재, 우리 수정은 vendor 밖에서 wrapping.
- 소싱은 `opencut-app/opencut-classic` 아카이브 커밋 고정 (v0.3.0 태그·main 재평가 서사는 폐기 — [step-d-master-build-plan.md](step-d-master-build-plan.md) §7.2).
- 스택 궁합: classic도 React 19 + Tailwind — 패턴 참고·스타일 이식 마찰 낮음.
- 참고: 구현 코드 주석의 `plan §7.3`·`§7.4`·`§2.4` 번호는 이 문서가 아니라 [step-d-master-build-plan.md](step-d-master-build-plan.md)의 섹션 번호다(§7.3 비파괴 통합 설계, §7.4 편집기 마일스톤, §2.4 렌더 불변식). 이 문서에는 번호 체계가 없다.

## 진행 현황 (구 "순서 제안")

1. ✅ 웨이브폼 + 타임코드 입력 (커밋 `201dd54`) — 단, 리트림 **발화 경계 자동 스냅은 미구현**(웨이브폼 시각 확인 + 수동 입력까지)
2. ✅ 자막·오버레이 직접 조작 편집 (인라인 텍스트 편집·드래그 이동·스냅 가이드·크기 조절) — 동일 커밋
3. ⬜ 편집 로그 계측 (운영자가 실제로 뭘 고치는지) — **미구현**. 코드에 계측 흔적 없음 → Phase 2 여부를 결정할 데이터가 아직 쌓이지 않는다.
