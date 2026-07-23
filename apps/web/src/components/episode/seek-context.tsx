"use client";

/**
 * SeekContext — 회차 화면의 원본 영상 플레이어와 파생 콘텐츠 카드(쇼츠·씬·자막·narrative)를 잇는다.
 * SourcePanel이 <video>를 등록하면 어느 카드든 `useVideoSeek().seekTo(sec)` 로 그 순간을 재생.
 * 카드 UI에서 결과 검증(이 쇼츠가 진짜 그 구간인가?)을 즉시 눈으로 할 수 있게 하는 배선의 핵심.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

interface SeekAPI {
  currentTime: number;
  hasVideo: boolean;
  registerVideo: (el: HTMLVideoElement | null) => void;
  seekTo: (time: number, opts?: { play?: boolean; scroll?: boolean; end?: number }) => void;
}

const Ctx = createContext<SeekAPI | null>(null);

export function SeekProvider({ children }: { children: React.ReactNode }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 클립 카드 클릭으로 재생을 시작하면 그 클립의 end 시각에 자동 정지. null이면 정지 없음.
  const stopAtRef = useRef<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [hasVideo, setHasVideo] = useState(false);

  const registerVideo = useCallback((el: HTMLVideoElement | null) => {
    if (videoRef.current === el) return;
    if (videoRef.current) {
      videoRef.current.ontimeupdate = null;
    }
    videoRef.current = el;
    setHasVideo(!!el);
    if (el) {
      // Native handler avoids a React rerender on every 250ms tick — just updates state.
      el.ontimeupdate = () => {
        setCurrentTime(el.currentTime);
        const stop = stopAtRef.current;
        if (stop != null && el.currentTime >= stop) {
          el.pause();
          stopAtRef.current = null;
        }
      };
    }
  }, []);

  const seekTo = useCallback(
    (time: number, opts?: { play?: boolean; scroll?: boolean; end?: number }) => {
      const v = videoRef.current;
      if (!v) return;
      const t = Math.max(0, Number.isFinite(time) ? time : 0);
      // 이번 seek에 end가 지정되면 그 지점에서 자동 정지. 매 호출마다 리셋(이전 클립의 정지선을 끌고 가지 않음).
      stopAtRef.current =
        typeof opts?.end === "number" && Number.isFinite(opts.end) && opts.end > t ? opts.end : null;
      v.currentTime = t;
      if (opts?.play !== false) v.play().catch(() => {});
      if (opts?.scroll !== false) {
        v.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [],
  );

  return (
    <Ctx.Provider value={{ currentTime, hasVideo, registerVideo, seekTo }}>
      {children}
    </Ctx.Provider>
  );
}

/** Read-only for cards that just want to jump. Returns null if no <SeekProvider> above. */
export function useVideoSeek(): SeekAPI | null {
  return useContext(Ctx);
}

/** For the source video player — register the video element in a stable effect. */
export function useRegisterVideo(el: HTMLVideoElement | null) {
  const ctx = useContext(Ctx);
  useEffect(() => {
    ctx?.registerVideo(el);
    return () => ctx?.registerVideo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);
}
