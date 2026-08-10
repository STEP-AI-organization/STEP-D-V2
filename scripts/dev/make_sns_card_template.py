"""sns-card 템플릿 프레임 생성 — SNS 게시물 스타일 쇼츠.

레이아웃 참고: 프로필 헤더 + 형광 제목 2줄 + 영상 카드 + 캡션 + 댓글 카드.
**채널명·프로필·인증배지는 슬롯으로만 둔다** — 특정 계정 브랜딩을 복제하지 않는다.

영상 자리는 **투명(알파 0)** 으로 뚫는다. render_with_template.py 가 이 PNG 를
영상 위에 통째로 얹으면 뚫린 구멍으로만 영상이 보인다.

  python scripts/dev/make_sns_card_template.py
"""
from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageDraw

W, H = 1080, 1920
OUT = Path(__file__).resolve().parents[2] / "assets" / "shorts-template" / "sns-card"

CARD_BG = (255, 255, 255, 255)
PAGE_BG = (242, 242, 244, 255)
COMMENT_BG = (238, 238, 241, 255)
AVATAR_BG = (222, 224, 228, 255)
LINE = (226, 226, 230, 255)

# 영상 구멍 — meta.json 의 video 와 반드시 같아야 한다.
VIDEO = (60, 560, 1020, 1300)  # x0, y0, x1, y1


def rounded(d: ImageDraw.ImageDraw, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)


def main() -> None:
    img = Image.new("RGBA", (W, H), PAGE_BG)
    d = ImageDraw.Draw(img)

    # 게시물 카드 (전체를 감싸는 흰 판)
    rounded(d, (30, 60, W - 30, H - 60), 28, CARD_BG)

    # 프로필 아바타 자리 (원) — 실제 이미지는 렌더 시 얹거나 비워둔다
    d.ellipse((80, 130, 210, 260), fill=AVATAR_BG)

    # 영상 카드 자리를 투명으로 뚫는다
    hole = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hole)
    hd.rounded_rectangle(VIDEO, radius=24, fill=(0, 0, 0, 255))
    img.paste((0, 0, 0, 0), (0, 0), hole)

    # 캡션 아래 구분선
    d.line((90, 1400, W - 90, 1400), fill=LINE, width=2)

    # 댓글 카드
    rounded(d, (90, 1440, W - 90, 1700), 20, COMMENT_BG)
    d.ellipse((130, 1480, 190, 1540), fill=AVATAR_BG)          # 댓글 작성자 아바타
    d.rounded_rectangle((210, 1492, 470, 1516), radius=8, fill=AVATAR_BG)  # 이름 자리
    for i, y in enumerate((1560, 1610)):                        # 댓글 본문 자리
        w = 760 if i == 0 else 520
        d.rounded_rectangle((130, y, 130 + w, y + 26), radius=8, fill=(228, 229, 233, 255))

    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / "overlay.png")
    print(f"OK {OUT / 'overlay.png'}  {img.size}  video hole={VIDEO}")


if __name__ == "__main__":
    main()
