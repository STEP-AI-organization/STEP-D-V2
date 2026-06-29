"use client";

import { useState, type CSSProperties, type HTMLAttributes } from "react";

/* A div that swaps in `hoverStyle` on mouse-over — the React equivalent of the
 * HTML design's custom `style-hover` attribute. For repeated hovers prefer the
 * utility classes in ConsoleGlobalStyle; use this for one-off dynamic styles. */
export function Hoverable({
  style,
  hoverStyle,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { hoverStyle?: CSSProperties }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      {...rest}
      style={{ ...style, ...(hovered ? hoverStyle : undefined) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </div>
  );
}
