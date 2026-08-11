import { AppShell } from "@/components/shell/app-shell";
import { AuthGuard } from "@/components/shell/auth-guard";
import { CommandPalette } from "@/components/shell/command-palette";
import { GateSummaryProvider } from "@/lib/gate-summary";

// AppDataProvider lives in the root layout so the (editor) group shares the store too.
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <GateSummaryProvider>
        <AppShell>{children}</AppShell>
        <CommandPalette />
      </GateSummaryProvider>
    </AuthGuard>
  );
}
