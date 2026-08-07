# 개발·진단 스크립트

파이프라인 결과를 눈으로 확인하거나 단계별로 진단할 때 쓰는 것들.
**프로덕션 경로가 아니다** — `core/` 나 `apps/server/` 에서 import 하지 않는다.

| 스크립트 | 용도 |
|---|---|
| `shorts_viewer.py` | 쇼츠 결과 브라우저 뷰어 (video + 카드 · click to seek) |
| `beats_viewer.py`* | beat 결과 뷰어 |
| `diarization_viewer.py` | 화자분리 확인 뷰어 (refined.json 의 utterance 별 speaker) |
| `diag_chyron.py` | 프레임 1장에 대한 Gemini raw 응답 확인 (chyron 감지 진단) |
| `pick_hook_beat.py` | 쇼츠별 hook_beat_id 를 Gemini 별도 콜로 선택 |
| `render_shorts.py` | 쇼츠 실제 렌더링 (ffmpeg trim + 첫 3초 hook_intro) |
| `test_whisperx.py` · `run_whisperx_view.py` | WhisperX 배선 스모크 (⚠️ 레거시 · 현행 STT 는 Soniox/whisper) |

\* 통합 검토 뷰어는 `scripts/make_review_viewer.py` 를 쓰는 게 낫다 —
영상 + beat + 쇼츠 + 검색을 한 화면에서 본다.

> 2026-08-07: 원래 `tmp/gebd/scripts/` 에 있었다. `.gitignore` 가 `/tmp/` 를 막기 전에
> 커밋돼서 추적만 되고 있던 것들이라 제대로 된 위치로 옮겼다.
