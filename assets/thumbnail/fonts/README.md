# 썸네일 폰트

`core/thumbnail.py` (Phase 1+, `docs/plans/thumbnail-engine-plan.md` §3.2)가 사용.

## 다운로드

리포에 .otf 파일 안 담김 (gitignore · 61MB 부담). 로컬에서 한 번만:

```
powershell -File scripts\download-fonts.ps1
```

## 폰트 목록 · 라이선스

전부 **SIL Open Font License 1.1** — 상용 상관 OK, 재배포 시 라이선스 고지.

| 파일 | 출처 | 용도 |
|------|------|------|
| Pretendard-Bold.otf | https://github.com/orioncactus/pretendard | 기본 · 모든 장르 |
| Pretendard-ExtraBold.otf | 위와 동일 | 강조용 |
| Pretendard-Black.otf | 위와 동일 | 최대 임팩트 |
| NotoSansKR-Bold.otf | https://github.com/notofonts/noto-cjk | 예능 · 굵은 임팩트 |
| NotoSansKR-Black.otf | 위와 동일 | 예능 · 최대 강조 |
| NotoSerifKR-Black.otf | 위와 동일 | 드라마 · 감성 · 세리프 |

## 추가 후보 (필요 시 별도 다운)

- **카페24 시리즈** — https://fonts.cafe24.com (브랜드 무료 상용 · 조건 확인)
- **배민 시리즈** — https://www.woowahan.com/fonts (개성 강함 · 예능 특수)
- **G마켓 산스** — 유쾌한 톤 (조건 확인)
