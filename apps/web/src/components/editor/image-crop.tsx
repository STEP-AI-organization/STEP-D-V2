"use client";

import { useEffect, useRef, useState } from "react";
import { X, Play } from "lucide-react";

/** 원본 이미지 안에서 프레임에 채울 사각형을 잡는 UI.
 *
 *  ⚠️ 2026-08-11 현재 이 파일을 import 하는 곳이 없다. 배경 이미지 크롭 블록이 붙어 있던
 *  editor-panel.tsx 에서, 서버 렌더가 배경 이미지를 합성하지 않아 화면에서만 바뀌던 UI 라
 *  제거됐다. 서버가 배경 이미지 렌더를 지원하면 LayoutTab 에 다시 연결한다 — 그때까지는
 *  어떤 경로로도 열리지 않는 보관 코드다.
 *
 *  UX: **뷰포트 고정, 이미지가 움직인다** (iOS 배경화면 조정·알파컷 스타일).
 *  - 프레임(target aspect) 사각형은 화면 중앙에 고정
 *  - 이미지를 드래그해서 이동, 휠·슬라이더로 확대/축소
 *  - 프레임 안쪽에 보이는 부분이 곧 크롭 결과 (실제 영상 프리뷰와 동일한 시야)
 *
 *  결과값(value)은 원본 이미지 대비 %(xPct/yPct/wPct/hPct).
 */
export interface ImageCropValue {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

/** 크롭 사각형을 큰 다이얼로그에서 잡는 컴포넌트.
 *  트리거: "영역 선택 편집" 버튼 (open → 모달). 저장 시 onSave 콜백 호출. */
export function ImageCropButton({
  src,
  targetAspect,
  value,
  onChange,
  label = "영역 선택 편집",
}: {
  src: string;
  targetAspect: number;
  value: ImageCropValue | undefined;
  onChange: (v: ImageCropValue) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
      >
        {label}
      </button>
      {open && (
        <ImageCropDialog
          src={src}
          targetAspect={targetAspect}
          initialValue={value}
          onSave={(v) => {
            onChange(v);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

// 예능 팝(korean_pop) 스타일 타이틀 mock — 실제 렌더의 서브셋. 노란 채움 + 검정 스트로크 + 그림자.
const titleStyle: React.CSSProperties = {
  color: "#FFD400",
  fontSize: "20px",
  fontWeight: 900,
  WebkitTextStroke: "1.6px rgba(0,0,0,0.92)",
  textShadow: "0 2px 6px rgba(0,0,0,0.7)",
  letterSpacing: "0.02em",
  lineHeight: 1.15,
  whiteSpace: "nowrap",
};

function ImageCropDialog({
  src,
  targetAspect,
  initialValue,
  onSave,
  onCancel,
}: {
  src: string;
  targetAspect: number;
  initialValue: ImageCropValue | undefined;
  onSave: (v: ImageCropValue) => void;
  onCancel: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null);
  // scale = image display multiplier · offset = image top-left in frame coords (px)
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);

  // 프레임의 실제 px 크기 관측 (aspectRatio + max 규칙 적용된 후)
  useEffect(() => {
    if (!frameRef.current) return;
    const el = frameRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        const h = e.contentRect.height;
        if (w > 0 && h > 0) setFrameSize({ w, h });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 이미지 로드 · 프레임 크기 확정 → 초기 scale/offset 시드
  useEffect(() => {
    if (!imgSize || !frameSize) return;
    if (initialValue) {
      // 기존 값이 있으면 역산: scale·offset 복원
      const s = frameSize.w / ((initialValue.wPct / 100) * imgSize.w);
      const ox = -s * (initialValue.xPct / 100) * imgSize.w;
      const oy = -s * (initialValue.yPct / 100) * imgSize.h;
      setScale(s);
      setOffset({ x: ox, y: oy });
    } else {
      // 최소 배율(프레임 커버 · 짧은 축 기준) 로 시작, 중앙 정렬
      const min = Math.max(frameSize.w / imgSize.w, frameSize.h / imgSize.h);
      const iw = imgSize.w * min;
      const ih = imgSize.h * min;
      setScale(min);
      setOffset({ x: (frameSize.w - iw) / 2, y: (frameSize.h - ih) / 2 });
    }
    setReady(true);
  }, [imgSize, frameSize, initialValue]);

  // 최소 배율 · 상한 계산
  const minScale = imgSize && frameSize ? Math.max(frameSize.w / imgSize.w, frameSize.h / imgSize.h) : 1;
  const maxScale = minScale * 8;

  // offset을 프레임 커버 조건에 맞춰 clamp (이미지 어느 방향으로도 프레임 밖으로 안 밀림)
  function clampOffset(nextOffset: { x: number; y: number }, s: number) {
    if (!imgSize || !frameSize) return nextOffset;
    const iw = imgSize.w * s;
    const ih = imgSize.h * s;
    const x = Math.min(0, Math.max(frameSize.w - iw, nextOffset.x));
    const y = Math.min(0, Math.max(frameSize.h - ih, nextOffset.y));
    return { x, y };
  }

  // ── 드래그 (팬) ──────────────────────────────────────────
  const dragRef = useRef<null | { sx: number; sy: number; sOffset: { x: number; y: number } }>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (!ready) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, sOffset: { ...offset } };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    setOffset(clampOffset({ x: d.sOffset.x + dx, y: d.sOffset.y + dy }, scale));
  }
  function onPointerUp() {
    dragRef.current = null;
  }

  // ── 휠 줌 (커서 중심) ─────────────────────────────────────
  function onWheel(e: React.WheelEvent) {
    if (!frameRef.current || !imgSize || !frameSize) return;
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const nextScale = Math.max(minScale, Math.min(maxScale, scale * factor));
    if (nextScale === scale) return;
    const rect = frameRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // 커서 아래 이미지 좌표(px)를 고정한 채 스케일 변경
    const imgX = (mx - offset.x) / scale;
    const imgY = (my - offset.y) / scale;
    const nextOffset = { x: mx - imgX * nextScale, y: my - imgY * nextScale };
    setOffset(clampOffset(nextOffset, nextScale));
    setScale(nextScale);
  }

  // ── 슬라이더 줌 (프레임 중심) ──────────────────────────────
  function onZoomSlider(v: number) {
    if (!frameSize) return;
    const nextScale = v;
    if (nextScale === scale) return;
    // 프레임 중심의 이미지 좌표를 고정하며 스케일 변경
    const cx = frameSize.w / 2;
    const cy = frameSize.h / 2;
    const imgX = (cx - offset.x) / scale;
    const imgY = (cy - offset.y) / scale;
    const nextOffset = { x: cx - imgX * nextScale, y: cy - imgY * nextScale };
    setOffset(clampOffset(nextOffset, nextScale));
    setScale(nextScale);
  }

  // ── ESC 취소 · Enter 저장 ─────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter" && ready) doSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, scale, offset]);

  function computeCrop(): ImageCropValue | null {
    if (!imgSize || !frameSize) return null;
    // 프레임 뷰포트에 들어온 이미지 영역 → 원본 이미지 대비 %로
    const xPct = ((-offset.x) / scale) / imgSize.w * 100;
    const yPct = ((-offset.y) / scale) / imgSize.h * 100;
    const wPct = (frameSize.w / scale) / imgSize.w * 100;
    const hPct = (frameSize.h / scale) / imgSize.h * 100;
    return {
      xPct: Math.max(0, Math.min(100, xPct)),
      yPct: Math.max(0, Math.min(100, yPct)),
      wPct: Math.max(1, Math.min(100 - Math.max(0, xPct), wPct)),
      hPct: Math.max(1, Math.min(100 - Math.max(0, yPct), hPct)),
    };
  }

  function doSave() {
    const v = computeCrop();
    if (v) onSave(v);
  }

  function resetView() {
    if (!imgSize || !frameSize) return;
    const min = Math.max(frameSize.w / imgSize.w, frameSize.h / imgSize.h);
    const iw = imgSize.w * min;
    const ih = imgSize.h * min;
    setScale(min);
    setOffset({ x: (frameSize.w - iw) / 2, y: (frameSize.h - ih) / 2 });
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-[92vh] w-[min(1100px,92vw)] flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-semibold text-zinc-100">배경으로 쓸 영역 선택</div>
          <button
            onClick={onCancel}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            title="닫기 (Esc)"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div className="text-[11px] text-zinc-500">
            프레임의 <b>영상 영역</b> 레이아웃을 참고해 배경을 배치하세요 · 이미지 <b>드래그</b>로 위치, <b>휠</b>·슬라이더로 확대/축소 · 프레임 밖으로 밀리지 않는 범위에서 자유롭게.
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-zinc-900/30">
            <div
              ref={frameRef}
              className="relative select-none overflow-hidden rounded-md border-2 border-white bg-black"
              style={{
                aspectRatio: targetAspect,
                // 9:16 세로 프레임엔 height 기준, 16:9 가로엔 width 기준으로 크기 결정
                height: targetAspect < 1 ? "min(72vh, 640px)" : undefined,
                width: targetAspect >= 1 ? "min(72%, 800px)" : undefined,
                maxWidth: "72%",
                maxHeight: "72vh",
                boxShadow: "0 0 0 9999px rgba(0,0,0,.55)",
                cursor: dragRef.current ? "grabbing" : "grab",
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
            >
              <img
                src={src}
                alt=""
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  if (el.naturalWidth && el.naturalHeight) {
                    setImgSize({ w: el.naturalWidth, h: el.naturalHeight });
                  }
                }}
                style={{
                  position: "absolute",
                  left: `${offset.x}px`,
                  top: `${offset.y}px`,
                  width: imgSize ? `${imgSize.w * scale}px` : undefined,
                  height: imgSize ? `${imgSize.h * scale}px` : undefined,
                  maxWidth: "none",
                  pointerEvents: "none",
                  userSelect: "none",
                  opacity: ready ? 1 : 0,
                  transition: "opacity 120ms ease",
                }}
              />
              {/* 영상영역 mock — ALPHACUT 스타일. 실제 STEPD 쇼츠 컴포지션 (타이틀+영상+브랜딩)이
                  배경 이미지 위에 어떻게 얹힐지 그대로 재현. 배경은 이 mock 요소 사이·주변에서
                  실제로 노출된다 (특히 상단 여백·타이틀 배경·하단 채널 여백). */}
              <div className="pointer-events-none absolute inset-0" style={{ zIndex: 10 }}>
                {/* 상단 타이틀 (예능 팝 스타일: 노란 채움 + 검정 스트로크) */}
                <div
                  className="absolute flex flex-col items-center gap-1"
                  style={{ left: "6%", right: "6%", top: "16%" }}
                >
                  <div style={titleStyle}>쇼츠 제목 첫번째 줄</div>
                  <div style={titleStyle}>쇼츠 제목 마지막 줄</div>
                </div>

                {/* 중앙 영상 영역 placeholder (다크박스 + 재생 버튼 + STEP D 워터마크) */}
                <div
                  className="absolute overflow-hidden rounded-sm"
                  style={{
                    left: "8%", right: "8%", top: "36%", bottom: "26%",
                    background: "rgba(20,20,20,0.85)",
                    border: "1px solid rgba(255,255,255,0.15)",
                  }}
                >
                  {/* diagonal STEP D 워터마크 텍스트 스트라이프 */}
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        "repeating-linear-gradient(-25deg, transparent 0, transparent 24px, rgba(255,255,255,0.06) 24px, rgba(255,255,255,0.06) 46px)",
                    }}
                  />
                  <div
                    className="absolute inset-0 flex select-none flex-wrap items-center justify-center opacity-30"
                    style={{
                      transform: "rotate(-25deg)",
                      fontSize: "14px",
                      fontWeight: 800,
                      letterSpacing: "0.08em",
                      color: "rgba(255,255,255,0.35)",
                      lineHeight: 1.8,
                    }}
                  >
                    STEP D · STEP D · STEP D · STEP D · STEP D · STEP D · STEP D · STEP D · STEP D · STEP D
                  </div>
                  {/* 재생 버튼 (YT 스타일 빨간 원 + 흰 삼각형) */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div
                      className="flex items-center justify-center rounded-full"
                      style={{
                        width: "44px",
                        height: "44px",
                        background: "#E62117",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
                      }}
                    >
                      <Play className="size-5" style={{ color: "#fff", fill: "#fff", marginLeft: "2px" }} />
                    </div>
                  </div>
                </div>

                {/* 하단 브랜딩 (공식 채널명 + STEP D 로고 자리) */}
                <div
                  className="absolute flex flex-col items-center gap-1.5"
                  style={{ left: 0, right: 0, bottom: "9%" }}
                >
                  <div
                    style={{
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: 800,
                      textShadow: "0 1px 3px rgba(0,0,0,0.75)",
                      letterSpacing: "0.02em",
                    }}
                  >
                    공식 채널명
                  </div>
                  <div
                    className="flex items-center justify-center rounded-md px-2 py-0.5"
                    style={{
                      background: "rgba(0,0,0,0.35)",
                      color: "#fff",
                      fontSize: "11px",
                      fontWeight: 900,
                      letterSpacing: "0.15em",
                    }}
                  >
                    STEP D
                  </div>
                </div>

                {/* 좌상단 안내 라벨 — 목업 문구·기하가 전부 하드코딩이라 실제 편집값(제목·채널명·
                    위치·프레임)과 무관하다. "최종 미리보기"라고 부르면 거짓말이 된다. */}
                <div
                  className="absolute rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    left: "8px", top: "8px",
                    background: "rgba(0,0,0,0.65)",
                    color: "rgba(255,255,255,0.9)",
                  }}
                >
                  배치 참고용 예시 (실제 편집값 아님)
                </div>
              </div>
            </div>
          </div>
          {/* 줌 슬라이더 */}
          {imgSize && frameSize && (
            <div className="flex items-center gap-3 px-2 text-[11px] text-zinc-400">
              <button
                onClick={resetView}
                className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                title="원래 크기로"
              >
                맞춤
              </button>
              <span>축소</span>
              <input
                type="range"
                min={minScale}
                max={maxScale}
                step={(maxScale - minScale) / 200}
                value={scale}
                onChange={(e) => onZoomSlider(Number(e.target.value))}
                className="flex-1 accent-white"
              />
              <span>확대</span>
              <span className="w-12 text-right tabular-nums text-zinc-500">
                {(scale / minScale).toFixed(1)}×
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            취소
          </button>
          <button
            onClick={doSave}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-200"
            disabled={!ready}
          >
            적용
          </button>
        </div>
      </div>
    </div>
  );
}
