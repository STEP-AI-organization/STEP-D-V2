from typing import Any


RENDER_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "clean",
        "label": "Clean",
        "platform": "none",
        "kind": "none",
        "badge_text": "",
        "position": "top_right",
        "scale": 0.12,
    },
    {
        "id": "youtube_shorts_badge",
        "label": "YouTube Shorts",
        "platform": "youtube",
        "kind": "text_badge",
        "badge_text": "YouTube Shorts",
        "position": "top_right",
        "scale": 0.12,
    },
    {
        "id": "meta_reels_badge",
        "label": "Meta Reels",
        "platform": "meta",
        "kind": "text_badge",
        "badge_text": "Reels",
        "position": "top_right",
        "scale": 0.12,
    },
    {
        "id": "soop_badge",
        "label": "SOOP",
        "platform": "soop",
        "kind": "text_badge",
        "badge_text": "SOOP",
        "position": "top_right",
        "scale": 0.12,
    },
    {
        "id": "minimal_corner",
        "label": "Minimal Corner",
        "platform": "generic",
        "kind": "text_badge",
        "badge_text": "SHORTS",
        "position": "bottom_right",
        "scale": 0.1,
    },
    {
        "id": "top_banner",
        "label": "Top Banner",
        "platform": "generic",
        "kind": "text_badge",
        "badge_text": "HIGHLIGHT",
        "position": "top_center",
        "scale": 0.16,
    },
]


ALLOWED_OVERLAY_POSITIONS = {"top_right", "top_left", "bottom_right", "bottom_left", "top_center"}


def list_render_templates() -> list[dict[str, Any]]:
    return [dict(template) for template in RENDER_TEMPLATES]


def get_render_template(template_id: str) -> dict[str, Any]:
    for template in RENDER_TEMPLATES:
        if template["id"] == template_id:
            return dict(template)
    return dict(RENDER_TEMPLATES[0])
