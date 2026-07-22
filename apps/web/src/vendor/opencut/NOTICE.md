# Vendored Code Notice — OpenCut (Classic)

이 폴더의 코드는 오픈소스 프로젝트에서 vendored(복사·이식)한 것입니다.
편집기 강화 목적으로 아래 원본에서 발췌·이식했습니다.

## 원본

- **프로젝트**: [opencut-app/opencut-classic](https://github.com/opencut-app/opencut-classic)
- **커밋 시점**: 2026-05-17 아카이브 (main 재작성 후 legacy로 보관)
- **라이선스**: MIT (본 폴더의 `LICENSE` 파일 참조)
- **저작권**: (c) OpenCut contributors

## 이식된 파일

| 파일 | 원본 경로 | 이식 사유 |
|---|---|---|
| `ruler-utils.ts` | `apps/web/src/timeline/ruler-utils.ts` | CapCut 스타일 타임라인 눈금 간격 계산 (2·3·5·10·15 프레임 패턴, 원본 주석에 "matches CapCut" 명시) |

## 이식 규칙

1. **격리**: 이 폴더(`apps/web/src/vendor/opencut/`) 안에서만 원본 코드 유지
2. **자립성**: 원본의 opencut-내부 의존(`opencut-wasm`, `@/timeline/scale`, `@/fps/utils` 등)은 이 폴더 안 로컬 정의로 대체 — 우리 EditorState와는 별도 어댑터 계층에서 연결
3. **수정**: 원본 코드를 이 폴더 내에서 수정할 때는 파일 상단 주석에 변경 사항 기록
4. **라이선스**: LICENSE 파일 유지, 원본 코드에서 파생된 코드는 상단에 vendored 주석 유지

## STEP-D 통합 지점

- `apps/web/src/components/editor/editor-timeline.tsx`에서 이 폴더의 export를 import해 사용
- 이 폴더 자체는 우리 코드에 의존하지 않음 (역방향만 허용 = 자립성)

---

**참고**: opencut-classic은 아카이브 상태로 업스트림 유지보수가 없습니다. 여기서 vendoring한 코드는 우리가 소유·관리하는 상태입니다.
