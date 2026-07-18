"use client";

import { useCallback, useState } from "react";
import type { EditorState } from "./presets";

const MAX_HISTORY = 50;

interface History {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}

/** EditorState + undo/redo stacks. Drop-in for useState<EditorState> in editor-shell. */
export function useEditorHistory(init: () => EditorState) {
  const [h, setH] = useState<History>(() => ({ past: [], present: init(), future: [] }));

  const setState = useCallback(
    (next: EditorState | ((s: EditorState) => EditorState)) => {
      setH((cur) => {
        const present = typeof next === "function" ? next(cur.present) : next;
        if (present === cur.present) return cur;
        return {
          past: [...cur.past, cur.present].slice(-MAX_HISTORY),
          present,
          future: [],
        };
      });
    },
    [],
  );

  const update = useCallback(
    (patch: Partial<EditorState>) => setState((s) => ({ ...s, ...patch })),
    [setState],
  );

  const undo = useCallback(() => {
    setH((cur) => {
      if (cur.past.length === 0) return cur;
      return {
        past: cur.past.slice(0, -1),
        present: cur.past[cur.past.length - 1],
        future: [cur.present, ...cur.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setH((cur) => {
      if (cur.future.length === 0) return cur;
      const [next, ...rest] = cur.future;
      return {
        past: [...cur.past, cur.present].slice(-MAX_HISTORY),
        present: next,
        future: rest,
      };
    });
  }, []);

  /** Replace state and wipe history — for hydrating a saved revision, not an edit. */
  const reset = useCallback((state: EditorState) => {
    setH({ past: [], present: state, future: [] });
  }, []);

  return {
    state: h.present,
    setState,
    update,
    undo,
    redo,
    reset,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}
