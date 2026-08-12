"use client";

import { useCallback, useRef, useState } from "react";
import type { EditorState } from "./presets";

const MAX_HISTORY = 50;
/** 같은 필드를 이 간격 안에 다시 만지면 같은 조작으로 본다(드래그·슬라이더 연속 입력). */
const COALESCE_MS = 600;

interface History {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}

/** EditorState + undo/redo stacks. Drop-in for useState<EditorState> in editor-shell. */
export function useEditorHistory(init: () => EditorState) {
  const [h, setH] = useState<History>(() => ({ past: [], present: init(), future: [] }));

  // ── 연속 조작을 히스토리 한 항목으로 접기 ──────────────────────────────────
  //
  // 예전에는 setState 가 호출마다 past 에 push 했다. 드래그·슬라이더는 mousemove/input 마다
  // update 를 부르므로, 제목을 한 번 끌면 수십 개가 쌓여 MAX_HISTORY(50)를 넘겨 **그 이전의
  // 모든 편집 undo 기록이 밀려나 사라졌고**, Ctrl+Z 는 1픽셀씩 되돌아갔다.
  //
  // 배칭 방식 두 가지를 함께 쓴다:
  //  1. **명시적** — beginBatch(key)/endBatch. 드래그 시작~종료를 한 항목으로(가장 정확).
  //  2. **자동** — update(patch) 가 **같은 필드 집합**을 COALESCE_MS 안에 다시 건드리면 접는다.
  //     드래그 지점마다 beginBatch 를 안 불러도 titleX/titleY 반복, 슬라이더 한 필드 반복이
  //     자동으로 하나가 된다. 다른 필드로 바뀌거나 시간이 벌어지면 새 undo 항목.
  const batchKey = useRef<string | null>(null);   // 명시적 batch 진행 중이면 그 key
  const batchStarted = useRef(false);             // 이 batch 의 첫 스냅샷을 남겼는가
  const autoSig = useRef<string | null>(null);    // 마지막 자동배칭 필드 시그니처
  const autoAt = useRef(0);                        // 마지막 자동배칭 시각

  /** present 를 갈아끼우되 past 는 늘리지 않는다(같은 조작의 연속). */
  const replacePresent = (present: EditorState) =>
    setH((cur) => (present === cur.present ? cur : { ...cur, present, future: [] }));

  /** present 를 갈아끼우고 past 에 스냅샷 하나를 남긴다(새 조작). */
  const pushPresent = (present: EditorState) =>
    setH((cur) =>
      present === cur.present
        ? cur
        : { past: [...cur.past, cur.present].slice(-MAX_HISTORY), present, future: [] },
    );

  const setState = useCallback(
    (next: EditorState | ((s: EditorState) => EditorState), mergeSig?: string) => {
      setH((cur) => {
        const present = typeof next === "function" ? next(cur.present) : next;
        if (present === cur.present) return cur;

        // 1) 명시적 batch: 첫 변경만 push, 이후 replace.
        if (batchKey.current !== null) {
          if (batchStarted.current) return { ...cur, present, future: [] };
          batchStarted.current = true;
          return { past: [...cur.past, cur.present].slice(-MAX_HISTORY), present, future: [] };
        }

        // 2) 자동 배칭: 같은 필드 시그니처 + 짧은 간격이면 replace.
        if (mergeSig != null) {
          const now = Date.now();
          const same = autoSig.current === mergeSig && now - autoAt.current < COALESCE_MS;
          autoSig.current = mergeSig;
          autoAt.current = now;
          if (same) return { ...cur, present, future: [] };
        } else {
          autoSig.current = null; // 시그니처 없는 편집은 배칭 사슬을 끊는다.
        }

        return { past: [...cur.past, cur.present].slice(-MAX_HISTORY), present, future: [] };
      });
    },
    [],
  );

  const update = useCallback(
    (patch: Partial<EditorState>) => {
      // 필드 집합을 시그니처로 — 같은 필드만 반복하는 드래그·슬라이더가 자동으로 접힌다.
      const sig = Object.keys(patch).sort().join(",");
      setState((s) => ({ ...s, ...patch }), sig);
    },
    [setState],
  );

  /** 드래그·슬라이더 시작 시. 같은 key 로 이어지는 변경은 undo 한 번에 되돌아간다. */
  const beginBatch = useCallback((key: string) => {
    if (batchKey.current !== key) {
      batchKey.current = key;
      batchStarted.current = false;
    }
  }, []);

  /** 드래그·슬라이더 종료 시. 다음 변경은 다시 개별 히스토리 항목이 된다. */
  const endBatch = useCallback(() => {
    batchKey.current = null;
    batchStarted.current = false;
    autoSig.current = null;
  }, []);

  const undo = useCallback(() => {
    endBatch();
    setH((cur) => {
      if (cur.past.length === 0) return cur;
      return {
        past: cur.past.slice(0, -1),
        present: cur.past[cur.past.length - 1],
        future: [cur.present, ...cur.future],
      };
    });
  }, [endBatch]);

  const redo = useCallback(() => {
    endBatch();
    setH((cur) => {
      if (cur.future.length === 0) return cur;
      const [next, ...rest] = cur.future;
      return {
        past: [...cur.past, cur.present].slice(-MAX_HISTORY),
        present: next,
        future: rest,
      };
    });
  }, [endBatch]);

  /** Replace state and wipe history — for hydrating a saved revision, not an edit. */
  const reset = useCallback((state: EditorState) => {
    batchKey.current = null;
    batchStarted.current = false;
    autoSig.current = null;
    setH({ past: [], present: state, future: [] });
  }, []);

  return {
    state: h.present,
    setState,
    update,
    beginBatch,
    endBatch,
    undo,
    redo,
    reset,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}
