import numpy as np

from core.stt.speaker_rename import assign_speakers_from_captions, build_speaker_mapping
from core.vision.yolo_cast import aggregate_beat_matches, apply_beat_cast, match_embedding


def test_embedding_match_has_unknown_threshold_and_identity_margin():
    refs = [
        {"castId": "a", "name": "민준", "embedding": np.array([1.0, 0.0, 0.0])},
        {"castId": "b", "name": "하린", "embedding": np.array([0.0, 1.0, 0.0])},
    ]
    assert match_embedding([0.98, 0.05, 0.0], refs)["castId"] == "a"
    assert match_embedding([0.1, 0.1, 0.98], refs) is None
    assert match_embedding([0.71, 0.70, 0.0], refs, min_margin=0.05) is None


def test_beat_aggregation_requires_coverage_and_keeps_structured_evidence():
    rows = [
        {"beatId": 7, "frameIndex": 0, "time": 1.0, "matches": [
            {"castId": "a", "name": "민준", "similarity": 0.8}]},
        {"beatId": 7, "frameIndex": 1, "time": 2.0, "matches": []},
        {"beatId": 7, "frameIndex": 2, "time": 3.0, "matches": [
            {"castId": "a", "name": "민준", "similarity": 0.9}]},
    ]
    result = aggregate_beat_matches(rows, min_hits=2, min_coverage=0.5)
    assert result[7][0]["name"] == "민준"
    assert result[7][0]["hits"] == 2
    assert result[7][0]["coverage"] == 0.6667
    assert result[7][0]["confidence"] == 0.85


def test_checkpoint_merge_refreshes_title_identity_without_rerunning_yolo():
    beats = [{"id": 7, "characters_visible": ["옛 이름"],
              "characters_visible_source": "yolo_cast"}]
    checkpoint = {"beats": {"7": [{"castId": "a", "name": "민준", "confidence": 0.82}]}}
    ctx = {"titleCast": [{"actorName": "김도현", "characterNames": ["민준", "강민준"]}]}
    assert apply_beat_cast(beats, checkpoint, ctx) == 1
    assert beats[0]["characters_visible"] == ["민준"]
    assert beats[0]["cast_visible"][0]["actorName"] == "김도현"
    assert beats[0]["cast_visible"][0]["characterNames"] == ["민준", "강민준"]


def test_visible_person_is_never_assumed_to_be_the_speaker():
    beats = [{"start": 0, "end": 10, "characters": ["화자1"],
              "characters_visible": ["민준"], "characters_visible_source": "yolo_cast"}]
    registry = [{"name": "민준"}]
    assert build_speaker_mapping(beats, registry) == ({}, [])
    refined = [{"start": 1, "end": 2, "text": "안녕", "speaker": ""}]
    assert assign_speakers_from_captions(beats, refined, registry) == 0
    assert refined[0]["speaker"] == ""
