# GEBD (Generic Event Boundary Detection) — 장면 전환 학습모델 실행 이미지
#
# NIA "비디오 전환 경계 추론" 참조구현(Kotechnia)을 그대로 돌리기 위한 환경.
# 파이프라인 3단:
#   A. ffmpeg 로 영상을 CHUNK_SEC(=60s) 단위로 자름 (stream copy)
#   B. mmaction2 TSN 으로 청크별 clip feature 추출  ← 이 이미지가 필요한 이유
#   C. SJNET(cla/) 로 boundary 추론 → boundaries.json
#
# ⚠️ 버전이 전부 고정이다. 원본 `4.구축환경정보/requirements.txt` 가 torch==1.8.1+cu111 을
#    못박고 있고, 그 위에서만 도는 mmcv 1.x / mmaction2 0.x 조합이다. 최신으로 올리면
#    `tools/misc/clip_feature_extraction.py` 와 TSN config 경로가 통째로 사라진다(mmaction2 1.x 는
#    mmengine 기반으로 재작성됨). **올리지 말 것.**
#
# 빌드:  docker build -t stepd-gebd:latest -f deploy/gebd/Dockerfile deploy/gebd
# 실행:  docker run --rm --gpus all -v <host>:/gebd stepd-gebd:latest bash /gebd/scripts/run_long_v3.sh

FROM pytorch/pytorch:1.8.1-cuda11.1-cudnn8-devel

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    # mmcv 컴파일 시 Ampere(3060 Ti = sm_86) 커널 포함
    TORCH_CUDA_ARCH_LIST="8.6" \
    FORCE_CUDA=1

# apt 키 만료 회피 — 이 베이스는 2021년이라 CUDA 저장소 키가 죽어 있다
RUN rm -f /etc/apt/sources.list.d/cuda.list /etc/apt/sources.list.d/nvidia-ml.list && \
    apt-get update && apt-get install -y --no-install-recommends \
        git ffmpeg libsm6 libxext6 libgl1-mesa-glx wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# mmcv-full — torch1.8.0+cu111 prebuilt wheel (컴파일 회피 · 빌드 20분 절약)
RUN pip install --no-cache-dir \
      mmcv-full==1.3.18 \
      -f https://download.openmmlab.com/mmcv/dist/cu111/torch1.8.0/index.html

# 원본 스크립트가 쓰는 파이썬 패키지
#   pandas·parmap  extract_feature.py
#   ipywidgets     `from tqdm.notebook import tqdm` 가 이거 없으면 죽는다
#   decord         mmaction2 비디오 디코더
RUN pip install --no-cache-dir \
      pandas parmap tqdm ipywidgets decord opencv-python-headless einops

# mmaction2 0.x — clip_feature_extraction.py 와 TSN feature config 가 여기까지만 있다
WORKDIR /root/workspace
RUN git clone --depth 1 --branch v0.24.1 https://github.com/open-mmlab/mmaction2.git && \
    cd mmaction2 && pip install --no-cache-dir -r requirements/build.txt && \
    pip install --no-cache-dir -v -e .

# TSN 체크포인트를 이미지에 미리 받아 둔다 — 런타임에 네트워크가 없어도 돌고,
# 청크마다 재다운로드하는 낭비도 막는다 (mmaction2 는 ~/.cache/torch 를 본다)
RUN mkdir -p /root/.cache/torch/hub/checkpoints && \
    wget -q -O /root/.cache/torch/hub/checkpoints/tsn_r50_320p_1x1x3_100e_kinetics400_rgb_20200702-cc665e2a.pth \
      https://download.openmmlab.com/mmaction/recognition/tsn/tsn_r50_320p_1x1x3_100e_kinetics400_rgb/tsn_r50_320p_1x1x3_100e_kinetics400_rgb_20200702-cc665e2a.pth

# 참조구현 소스 (prepare/ = feature 추출, cla/ = SJNET 추론)
# run_long_v3.sh 가 `cd /root/workspace/prepare` 를 하드코딩하므로 경로를 맞춘다.
COPY prepare/ /root/workspace/prepare/
COPY cla/     /root/workspace/cla/

# 모델 가중치·실행 스크립트·입출력은 런타임에 -v 로 /gebd 에 마운트한다
# (가중치가 1.6GB라 이미지에 넣으면 배포가 무거워진다)
WORKDIR /root/workspace/prepare
CMD ["bash"]
