# WhisperX 실행 설명서 (Claude 에이전트용)

> **목표**: `TpQgkCs0TzE.mp4` (8분 2초, 한국어) 영상을 WhisperX large-v3로 트랜스크라이브 + word alignment해서 JSON 저장

---

## 1. 환경 정보

- **OS**: Windows 10
- **Python 경로**: `C:\Users\STEPAI05\AppData\Local\Programs\Python\Python312\python`
- **Python 버전**: 3.12
- **GPU**: NVIDIA, CUDA 12.4 사용 가능 (드라이버 설치됨)
- **작업 폴더**: `C:\Users\STEPAI05\STEPD-repo\core`
- **영상 파일**: `C:\Users\STEPAI05\STEPD-repo\core\TpQgkCs0TzE.mp4`

---

## 2. 의존성 설치

```bash
# torch cu124 + whisperx
/c/Users/STEPAI05/AppData/Local/Programs/Python/Python312/python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
/c/Users/STEPAI05/AppData/Local/Programs/Python/Python312/python -m pip install whisperx

# cuDNN 8.9 (PyTorch 2.6.0+cu124 호환 버전)
/c/Users/STEPAI05/AppData/Local/Programs/Python/Python312/python -m pip install nvidia-cudnn-cu12==8.9.7.29
```

---

## 3. 핵심 문제: PIL 충돌 + cuDNN DLL 누락

### 문제 A: PIL 충돌
Hermes 에이전트가 사용하는 PIL 패키지가 `C:\Users\STEPAI05\AppData\Local\hermes\hermes-agent\venv\Lib\site-packages\PIL`에 있고, Python 실행 시 `from PIL.Image import Image` 충돌이 발생한다.

**해결**: `-I` 플래그로 격리 실행

### 문제 B: cuDNN DLL 못 찾음
`-I` 모드에서는 cuDNN DLL (`cudnn_cnn_infer64_8.dll` 등) 경로가 `PATH`에 없어 로드 실패.

**해결**: Python 내부에서 `os.add_dll_directory()`로 명시적 등록

---

## 4. 최종 실행 스크립트

```python
# WHISPERX_CORE: C:\Users\STEPAI05\STEPD-repo\core\whisperx_runner.py
import os

# cuDNN DLL 경로 등록 (PyTorch import 전에!)
cudnn_dir = r'C:\Users\STEPAI05\AppData\Local\Programs\Python\Python312\Lib\site-packages\nvidia\cudnn\bin'
if os.path.isdir(cudnn_dir):
    os.add_dll_directory(cudnn_dir)

import whisperx, json, time

VIDEO = 'TpQgkCs0TzE.mp4'
OUTPUT = 'whisperx_result_wx.json'

t0 = time.time()

# 1. 모델 로드
print("[1/4] Loading large-v3 (CUDA, float16)...")
model = whisperx.load_model('large-v3', 'cuda', compute_type='float16', language='ko')
print(f"  Model loaded in {time.time()-t0:.1f}s")

# 2. 오디오 로드
t = time.time()
print("[2/4] Loading audio...")
audio = whisperx.load_audio(VIDEO)
print(f"  Audio loaded in {time.time()-t:.1f}s")

# 3. 트랜스크라이브
t = time.time()
print("[3/4] Transcribing...")
result = model.transcribe(audio, batch_size=16, language='ko')
print(f"  {len(result['segments'])} segments in {time.time()-t:.1f}s")

# 4. Word alignment
t = time.time()
print("[4/4] Aligning (word-level)...")
model_a, metadata = whisperx.load_align_model(language_code='ko', device='cuda')
result = whisperx.align(result['segments'], model_a, metadata, audio, 'cuda', return_char_alignments=False)
print(f"  Aligned in {time.time()-t:.1f}s")

# 5. 저장
with open(OUTPUT, 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2, default=str)

print(f"\nTOTAL: {time.time()-t0:.1f}s")
print(f"Segments: {len(result['segments'])}")
print(f"→ Saved: {OUTPUT}")

# 첫 10개 세그먼트 출력
for seg in result['segments'][:10]:
    ts = seg['start']
    print(f"  [{int(ts//60)}:{int(ts%60):02d}] {seg['text'].strip()}")
```

**실행 명령어**:
```bash
cd /c/Users/STEPAI05/STEPD-repo/core
/c/Users/STEPAI05/AppData/Local/Programs/Python/Python312/python -I whisperx_runner.py
```

---

## 5. 실패 시 대안

### 5a. cuDNN 버전 충돌
`cudnnGetLibConfig` 심볼 누락이면 cuDNN 9.x → 8.9.7.29로 변경 (`pip install nvidia-cudnn-cu12==8.9.7.29`)

### 5b. CPU 폴백 (느리지만 동작 보장)
```bash
/c/Users/STEPAI05/AppData/Local/Programs/Python/Python312/python -I -c "
import whisperx
model = whisperx.load_model('large-v3', 'cpu', compute_type='int8', language='ko')
result = model.transcribe(whisperx.load_audio('TpQgkCs0TzE.mp4'), language='ko')
import json
json.dump(result, open('whisperx_result_cpu.json','w',encoding='utf-8'), ensure_ascii=False, indent=2, default=str)
print(f'{len(result[\"segments\"])} segments saved')
"
```

### 5c. 빠르게 테스트 (tiny 모델)
```bash
/c/Users/STEPAI05/AppData/Local/Programs/Python/Python312/python -I -c "
import whisperx
model = whisperx.load_model('tiny', 'cuda', language='ko')
print('Model OK → CUDA/cuDNN works')
"
```

---

## 6. 예상 출력

```json
{
  "segments": [
    {
      "start": 0.0,
      "end": 4.5,
      "text": "자 한번 지금 저희가 저희들끼리",
      "words": [
        {"word": "자", "start": 0.0, "end": 0.3},
        {"word": "한번", "start": 0.3, "end": 0.8},
        ...
      ]
    },
    ...
  ]
}
```

---

## 7. 참고: faster-whisper 결과 (비교용)

이미 faster-whisper로 `whisperx_result.json` (214 세그먼트) 있음. WhisperX는 VAD 기반 세그먼테이션 + 강제 정렬로 더 정확한 단어 타임스탬프를 제공한다. large-v3 모델 자체는 동일하므로 텍스트 정확도는 유사하다.