"use client";

import { ConsoleProvider } from "./components/console/ConsoleProvider";
import { ConsoleGlobalStyle } from "./components/console/ConsoleGlobalStyle";
import { ConsoleShell } from "./components/console/ConsoleShell";

export default function Home() {
  return (
    <ConsoleProvider>
      <ConsoleGlobalStyle />
      <ConsoleShell />
    </ConsoleProvider>
  );
}
