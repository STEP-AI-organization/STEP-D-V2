"""Channel analytics via the YouTube Data API v3.

Pulls a connected channel's uploaded videos with view/like/comment counts and
ranks them, so the dashboard can show "top videos by views" and channel totals.
"""

from collections import Counter
from typing import Any

import httpx


YOUTUBE_API = "https://www.googleapis.com/youtube/v3"

SORT_KEYS = {
    "views": "view_count",
    "likes": "like_count",
    "comments": "comment_count",
    "recent": "published_at",
}


def _get(url: str, access_token: str, params: dict[str, Any]) -> dict[str, Any]:
    response = httpx.get(
        url,
        params=params,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"YouTube API error {response.status_code}: {response.text[:300]}")
    return response.json()


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _thumbnail(thumbnails: dict[str, Any]) -> str | None:
    for key in ("medium", "high", "default", "standard"):
        item = thumbnails.get(key)
        if item and item.get("url"):
            return item["url"]
    return None


def fetch_channel_overview(access_token: str, channel_id: str) -> dict[str, Any]:
    data = _get(
        f"{YOUTUBE_API}/channels",
        access_token,
        {"part": "snippet,statistics,contentDetails", "id": channel_id},
    )
    items = data.get("items") or []
    if not items:
        raise RuntimeError("Channel not found or not accessible with this account.")
    channel = items[0]
    statistics = channel.get("statistics", {})
    content_details = channel.get("contentDetails", {})
    uploads = (content_details.get("relatedPlaylists") or {}).get("uploads")
    if not uploads:
        raise RuntimeError("Channel has no uploads playlist.")
    snippet = channel.get("snippet", {})
    return {
        "uploads_playlist": uploads,
        "title": snippet.get("title", ""),
        "thumbnail": _thumbnail(snippet.get("thumbnails", {})),
        "subscriber_count": _int(statistics.get("subscriberCount")),
        "video_count": _int(statistics.get("videoCount")),
        "view_count": _int(statistics.get("viewCount")),
        "hidden_subscriber_count": bool(statistics.get("hiddenSubscriberCount")),
    }


def fetch_upload_video_ids(access_token: str, uploads_playlist: str, limit: int) -> list[str]:
    video_ids: list[str] = []
    page_token: str | None = None
    while len(video_ids) < limit:
        params: dict[str, Any] = {
            "part": "contentDetails",
            "playlistId": uploads_playlist,
            "maxResults": min(50, limit - len(video_ids)),
        }
        if page_token:
            params["pageToken"] = page_token
        data = _get(f"{YOUTUBE_API}/playlistItems", access_token, params)
        for item in data.get("items", []):
            video_id = (item.get("contentDetails") or {}).get("videoId")
            if video_id:
                video_ids.append(video_id)
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return video_ids[:limit]


def fetch_video_stats(access_token: str, video_ids: list[str]) -> list[dict[str, Any]]:
    videos: list[dict[str, Any]] = []
    for start in range(0, len(video_ids), 50):
        chunk = video_ids[start : start + 50]
        data = _get(
            f"{YOUTUBE_API}/videos",
            access_token,
            {"part": "snippet,statistics,contentDetails", "id": ",".join(chunk)},
        )
        for video in data.get("items", []):
            statistics = video.get("statistics", {})
            snippet = video.get("snippet", {})
            videos.append(
                {
                    "video_id": video.get("id"),
                    "title": snippet.get("title", ""),
                    "url": f"https://youtu.be/{video.get('id')}",
                    "thumbnail": _thumbnail(snippet.get("thumbnails", {})),
                    "published_at": snippet.get("publishedAt"),
                    "view_count": _int(statistics.get("viewCount")),
                    "like_count": _int(statistics.get("likeCount")),
                    "comment_count": _int(statistics.get("commentCount")),
                    "duration": (video.get("contentDetails") or {}).get("duration"),
                }
            )
    return videos


def fetch_video_comments(access_token: str, video_id: str, limit: int = 20) -> list[dict[str, Any]]:
    try:
        data = _get(
            f"{YOUTUBE_API}/commentThreads",
            access_token,
            {
                "part": "snippet",
                "videoId": video_id,
                "maxResults": max(1, min(50, limit)),
                "order": "time",
                "textFormat": "plainText",
            },
        )
    except RuntimeError as exc:
        # Comments disabled on the video -> empty list rather than an error.
        if "disabled" in str(exc).lower() or "commentsdisabled" in str(exc).lower():
            return []
        raise
    comments: list[dict[str, Any]] = []
    for item in data.get("items", []):
        top = (((item.get("snippet") or {}).get("topLevelComment") or {}).get("snippet")) or {}
        comments.append(
            {
                "author": str(top.get("authorDisplayName") or ""),
                "text": str(top.get("textDisplay") or ""),
                "likes": _int(top.get("likeCount")),
                "published_at": top.get("publishedAt"),
            }
        )
    return comments


def build_success_insights(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Pure heuristic analysis of a channel's published clips vs their YouTube stats.

    ``records`` items: video_id, title, url, views, likes, comments,
    duration_seconds, hook_terms (list), labels (list). Returns best-clip ranking,
    common traits of the top performers, and plain-Korean recommendations.
    """
    items = [dict(record) for record in records if record.get("video_id")]
    items.sort(key=lambda record: record.get("views", 0), reverse=True)
    for index, record in enumerate(items):
        record["rank"] = index + 1

    sample_size = len(items)
    has_enough = sample_size >= 3
    recommendations: list[str] = []
    patterns: dict[str, Any] = {}

    def _avg(values: list[float]) -> int:
        return round(sum(values) / len(values)) if values else 0

    if has_enough:
        top_n = max(1, round(sample_size / 3))
        top = items[:top_n]
        best_duration = _avg([record.get("duration_seconds", 0) for record in top])
        best_title_length = _avg([len(str(record.get("title", ""))) for record in top])
        counter: Counter[str] = Counter()
        for record in top:
            for term in (record.get("hook_terms") or []):
                counter[str(term)] += 1
            for term in (record.get("labels") or []):
                counter[str(term)] += 1
        top_terms = [term for term, _ in counter.most_common(5)]

        def _engagement(record: dict[str, Any]) -> float:
            views = record.get("views", 0) or 1
            return (record.get("likes", 0) + record.get("comments", 0)) / views

        engagement_pct = round((sum(_engagement(record) for record in top) / len(top)) * 100, 1)
        patterns = {
            "best_duration_seconds": best_duration,
            "best_title_length": best_title_length,
            "top_terms": top_terms,
            "avg_top_views": _avg([record.get("views", 0) for record in top]),
            "engagement_rate_pct": engagement_pct,
        }
        if best_duration:
            recommendations.append(f"이 채널에서 잘 되는 길이는 약 {best_duration}초 안팎이에요. 다음 쇼츠도 이 길이에 맞춰 보세요.")
        if best_title_length:
            recommendations.append(f"성과 좋은 쇼츠 제목은 평균 {best_title_length}자 정도였어요.")
        if top_terms:
            recommendations.append(f"자주 통한 후킹 요소: {', '.join(top_terms[:4])}")
        recommendations.append("첫 3초에 가장 센 장면이나 한마디를 배치한 쇼츠가 더 많이 노출됐어요.")
    else:
        recommendations.append("발행된 쇼츠가 더 쌓이면 ‘이 채널에서 잘 먹히는 스타일’을 분석해 드려요.")

    best_videos = [
        {
            "video_id": record["video_id"],
            "title": str(record.get("title", "")),
            "url": str(record.get("url", "")),
            "views": int(record.get("views", 0)),
            "likes": int(record.get("likes", 0)),
            "comments": int(record.get("comments", 0)),
            "duration_seconds": int(record.get("duration_seconds", 0)),
            "rank": record["rank"],
        }
        for record in items[:10]
    ]
    return {
        "sample_size": sample_size,
        "has_enough": has_enough,
        "best_videos": best_videos,
        "patterns": patterns,
        "recommendations": recommendations,
    }


def build_channel_analytics(
    access_token: str,
    channel_id: str,
    limit: int = 30,
    sort: str = "views",
) -> dict[str, Any]:
    overview = fetch_channel_overview(access_token, channel_id)
    video_ids = fetch_upload_video_ids(access_token, overview["uploads_playlist"], limit)
    videos = fetch_video_stats(access_token, video_ids)

    sort_key = SORT_KEYS.get(sort, "view_count")
    if sort_key == "published_at":
        videos.sort(key=lambda video: video.get("published_at") or "", reverse=True)
    else:
        videos.sort(key=lambda video: video.get(sort_key) or 0, reverse=True)
    for index, video in enumerate(videos):
        video["rank"] = index + 1

    totals = {
        "video_count": overview["video_count"],
        "subscriber_count": overview["subscriber_count"],
        "hidden_subscriber_count": overview["hidden_subscriber_count"],
        "channel_view_count": overview["view_count"],
        "sampled_videos": len(videos),
        "sampled_views": sum(video["view_count"] for video in videos),
        "sampled_likes": sum(video["like_count"] for video in videos),
        "sampled_comments": sum(video["comment_count"] for video in videos),
    }
    return {
        "channel_title": overview["title"],
        "channel_thumbnail": overview["thumbnail"],
        "sort": sort if sort in SORT_KEYS else "views",
        "totals": totals,
        "videos": videos,
    }
