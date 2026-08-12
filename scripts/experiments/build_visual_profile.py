"""base 프로파일에 Exp 5 visualProfile 병합. → ab_learned_visual.json"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(r"C:\Users\STEPAI05\STEPD-repo")
DATA = REPO / "바우처_결과보고_2026" / "증빙_데이터셋" / "실험자료"

base = json.load(open(DATA / "ab_learned_clean.json", encoding="utf-8"))
vp = json.load(open(DATA / "exp5_haha_visual_profile.json", encoding="utf-8"))

hints = vp["recommend_hints"]
# recommend_profile 안에 visualProfile 삽입
base["recommend_profile"]["visualProfile"] = {
    "prefer_hook_types": hints["prefer_hook_types"],
    "avoid_hook_types": hints["avoid_hook_types"],
    "prefer_colors": hints["prefer_colors"],
    "avoid_colors": hints["avoid_colors"],
    "prefer_face_close": hints["prefer_face_close"],
    "prefer_overlay": hints["prefer_overlay"],
    "_note": "Exp 5 194편 실증 · text_cue +13%p · reaction +10%p · situation -7%p · n_faces lift 1.58 · 흰색 lift 4.0",
}
base["confidence"] = 0.8  # 시각 신호 추가로 신뢰도 상향

out = DATA / "ab_learned_visual.json"
json.dump(base, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"저장: {out}")
print("visualProfile:", json.dumps(base["recommend_profile"]["visualProfile"], ensure_ascii=False, indent=2))
