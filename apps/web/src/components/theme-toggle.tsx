"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Toggles the `.dark` class on <html> and persists the choice. Paired with the
 *  no-flash init script in the root layout. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("stepd-theme", next ? "dark" : "light");
    } catch {
      // ignore storage failures (private mode etc.)
    }
    setDark(next);
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="테마 전환" title="테마 전환">
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
