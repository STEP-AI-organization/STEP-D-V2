r"""core.analyze 로컬 실행 러너 — .env 로드 + 올바른 venv 선택을 한 곳에 모은다.

사용:
    python scripts/run_analyze_local.py <video> --out <workdir> --genre drama [...]
    (그 뒤 인자는 core.analyze 로 그대로 전달된다)

왜 필요한가 — 로컬 실행에서 두 번 사고가 났다 (2026-08-07):

1. **환경변수를 안 넘기면 비싼 체크포인트가 지워진다.**
   `apps/server/.env` 의 `STT_PROVIDER=hybrid` 가 없으면 기본값 `gemini` 로 잡혀
   stt.json 지문이 어긋나고, 파이프라인이 stt.json·refined.json 을 지운다.
   (코드 쪽은 이제 .invalidated/ 로 옮기지만, 애초에 안 어긋나게 하는 게 맞다)

2. **bash 로 `.env` 를 source 하면 안 된다.**
   `GOOGLE_APPLICATION_CREDENTIALS=C:\Users\...` 처럼 값에 백슬래시가 있으면
   `set -a; . ./apps/server/.env` 가 이스케이프로 해석해 `C:UsersSTEPAI05...` 로
   뭉갠다 → Vertex 가 DefaultCredentialsError 로 죽고, refine 이 "10/10 batches
   kept raw STT text" 로 실패한다. 여기서는 파이썬으로 읽어 그대로 넘긴다.

3. **venv 를 골라야 한다.** `core/.venv`(3.11) 에는 faster_whisper·torch 가 없다.
   `STT_PROVIDER=hybrid|whisper` 는 `core/.venv310`(3.10 · GPU) 이어야 한다.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / "apps" / "server" / ".env"
VENV_GPU = ROOT / "core" / ".venv310" / "Scripts" / "python.exe"
VENV_CPU = ROOT / "core" / ".venv" / "Scripts" / "python.exe"
GPU_PROVIDERS = {"hybrid", "whisper", "whisperx"}


def load_env(path: Path) -> dict[str, str]:
    """KEY=VALUE 를 **그대로** 읽는다 — 셸 이스케이프 없음. 따옴표만 벗긴다."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    env = {**os.environ, **load_env(ENV_FILE)}
    provider = (env.get("STT_PROVIDER") or "gemini").lower()

    # 자격증명 파일이 실제로 있는지 먼저 본다 — 없으면 refine 이 조용히 원문을 남기고
    # 실패하는데, 그 시점엔 이미 STT 비용을 다 쓴 뒤다.
    cred = env.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and not Path(cred).exists():
        print(f"[run] ⚠️ 자격증명 파일 없음: {cred}")
        return 1

    py = VENV_GPU if provider in GPU_PROVIDERS else VENV_CPU
    if not py.exists():
        print(f"[run] ⚠️ 파이썬 없음: {py}")
        return 1

    print(f"[run] STT_PROVIDER={provider} · python={py.relative_to(ROOT)} · "
          f"cred={'OK' if cred else '없음'}")
    return subprocess.call([str(py), "-m", "core.analyze", *sys.argv[1:]],
                           cwd=str(ROOT), env=env)


if __name__ == "__main__":
    raise SystemExit(main())
