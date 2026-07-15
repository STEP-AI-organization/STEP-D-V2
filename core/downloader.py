"""
STEP D Core — Video Downloader
YouTube video downloader using yt-dlp.

Based on VideoLingo's _1_download.py (Apache 2.0)
"""
import subprocess
from pathlib import Path
from typing import Optional


def download(
    url: str,
    output_dir: Optional[str] = None,
    quality: str = 'best[height<=720]',
) -> str:
    """
    Download a YouTube video using yt-dlp.

    Args:
        url: YouTube URL
        output_dir: Where to save the video
        quality: yt-dlp format selector

    Returns:
        Path to the downloaded video file
    """
    if output_dir is None:
        output_dir = '.'

    output_template = str(Path(output_dir) / '%(id)s.%(ext)s')

    result = subprocess.run(
        [
            'yt-dlp',
            '-f', quality,
            '-o', output_template,
            '--no-playlist',
            # A bare --print implies --simulate (no download). --no-simulate forces the
            # download, and after_move:filepath prints the real path post-download.
            '--no-simulate',
            '--print', 'after_move:filepath',
            url,
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    # after_move:filepath prints the final saved path (last non-empty line)
    lines = [ln for ln in result.stdout.strip().split('\n') if ln.strip()]
    return lines[-1] if lines else ''


def get_video_info(url: str) -> dict:
    """Get video metadata without downloading."""
    result = subprocess.run(
        [
            'yt-dlp',
            '--dump-json',
            '--no-playlist',
            url,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    import json
    info = json.loads(result.stdout)
    return {
        'id': info['id'],
        'title': info['title'],
        'duration': info['duration'],
        'channel': info.get('channel', ''),
        'description': info.get('description', '')[:500],
        'view_count': info.get('view_count', 0),
        'upload_date': info.get('upload_date', ''),
    }