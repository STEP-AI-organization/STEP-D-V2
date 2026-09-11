import copy
import json
from pathlib import Path
from unittest.mock import patch

from core.recommend.title_names import guard_title_result, is_actor_title, title_names_prompt, NAMELESS_TITLE

FIXTURE = json.loads((Path(__file__).parent / "fixtures/title-names.json").read_text(encoding="utf-8"))
CTX = FIXTURE["program"]


def test_shared_name_cases():
    for case in FIXTURE["titles"]:
        assert is_actor_title(case["text"], CTX) == case["valid"], case["text"]
    assert is_actor_title("강민준의 선택", {})
    assert title_names_prompt({}) == ""


def test_guard_keeps_original_dialogue_and_analysis():
    short = {"title": "강민준의 선택", "title_line1": "김도현의 연기", "title_line2": "민준의 눈물",
             "title_candidates": ["강민준의 선택", "김도현의 눈빛", "김도현의 눈빛"],
             "hook_quote": "민준아 기다려", "characters": ["강민준"], "reason": "강민준이 기다린다"}
    result = guard_title_result({"shorts": [copy.deepcopy(short)]}, CTX)["shorts"][0]
    assert result["title"] == NAMELESS_TITLE
    assert result["title_line1"] == result["title_line2"] == ""
    assert result["title_candidates"] == [NAMELESS_TITLE, "김도현의 눈빛"]
    for key in ("hook_quote", "characters", "reason"):
        assert result[key] == short[key]
    assert guard_title_result({"shorts": [short]}, {}) == {"shorts": [short]}


def test_both_recommendation_entries_guard_fallback_results():
    import core.recommend.recommend as module
    raw = {"shorts": [{"title": "강민준의 선택"}]}
    with patch.object(module, "_recommend_impl", return_value=copy.deepcopy(raw)):
        assert module.recommend([{}], program_context=CTX)["shorts"][0]["title"] == NAMELESS_TITLE
    with patch.object(module, "_recommend_narrative_first_impl", return_value=copy.deepcopy(raw)):
        assert module.recommend_narrative_first([], transcript=[{}], program_context=CTX)["shorts"][0]["title"] == NAMELESS_TITLE
    assert module._CURRENT_PROGRAM_CTX is None


def test_policy_is_present_without_custom_prompt_and_does_not_leak_into_selection():
    import core.recommend.recommend as module
    block = module._operator_prompt_block(CTX, "titlePrompt", "제목 작성")
    assert "김도현" in block and "강민준" in block and "예외" in block
    assert "해당 구간에 근거" in block
    assert module._operator_prompt_block(CTX, "recommendPrompt", "추천") == ""


def test_changed_policy_invalidates_only_the_recommend_checkpoint(tmp_path):
    from core.analyze_stages import run_recommend
    (tmp_path / "shorts.json").write_text(json.dumps({"shorts": [{"title": "강민준의 선택"}]}), encoding="utf-8")
    with patch("core.recommend.recommend.recommend_narrative_first", return_value={
        "shorts": [{"title": "김도현의 선택"}], "genre": "drama"}):
        result = run_recommend(
            scenes=[{}], refined=[{}], cast_registry=None, narrative=None, faces=None,
            ppl=None, beats_data={}, profile=None, channels=None, video_path="video.mp4",
            program_context=CTX, shorts_n=1, genre="drama", out_dir=tmp_path,
            step=lambda _: None, timed=lambda *_: None)
    assert result["shorts"][0]["title"] == "김도현의 선택"
    assert result["_titleCast"] == CTX["titleCast"]
