"""프레임 1장에 대한 Gemini raw 응답 확인 (chyron 감지 실패 원인 진단)."""
import sys, os
from pathlib import Path

sys.path.insert(0, os.getcwd())

from google import genai
from google.genai import types

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
from core.models import NAMES as MODEL

frame = sys.argv[1] if len(sys.argv) > 1 else "tmp/gebd/late_frames/f_60s.jpg"
data = Path(frame).read_bytes()

client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

# Test 1: 우리 실제 프롬프트 + schema
from core.chyron_scan import PROMPT, SCHEMA
config1 = types.GenerateContentConfig(
    temperature=0,
    response_mime_type="application/json",
    response_schema=SCHEMA,
    max_output_tokens=512,
    thinking_config=types.ThinkingConfig(thinking_budget=0),
)
r1 = client.models.generate_content(
    model=MODEL,
    contents=[types.Part.from_bytes(data=data, mime_type="image/jpeg"), PROMPT],
    config=config1,
)
print(f"[test1 · our prompt+schema] {r1.text}")

# Test 2: schema 없이 자유 응답 · 프레임 안 텍스트 다 뽑기
config2 = types.GenerateContentConfig(
    temperature=0,
    max_output_tokens=1024,
    thinking_config=types.ThinkingConfig(thinking_budget=0),
)
r2 = client.models.generate_content(
    model=MODEL,
    contents=[
        types.Part.from_bytes(data=data, mime_type="image/jpeg"),
        "이 프레임에 있는 모든 화면 텍스트(자막·로고·이름표 등)를 위치와 함께 그대로 뽑아 나열해라.",
    ],
    config=config2,
)
print(f"\n[test2 · raw OCR free-form] {r2.text}")

# Test 3: 프레임에 인물 이름 태그가 있는지 직접 물음
r3 = client.models.generate_content(
    model=MODEL,
    contents=[
        types.Part.from_bytes(data=data, mime_type="image/jpeg"),
        "이 프레임 하단 좌측에 인물 이름이 대사 앞에 태그로 붙어있나? 있으면 그 이름만 답하고, 없으면 '없음' 이라고만 답해라.",
    ],
    config=config2,
)
print(f"\n[test3 · direct question] {r3.text}")
