import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import type { StatusTone } from "@/lib/constants";

const TONE_TEXT: Record<StatusTone, string> = {
  idle: "text-foreground",
  progress: "text-status-progress",
  done: "text-status-done",
  warn: "text-status-warn",
  error: "text-status-error",
};

export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = "idle",
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  /** Colors the value; defaults to neutral foreground. */
  tone?: StatusTone;
}) {
  return (
    <Card className="px-4.5 py-4">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {label}
      </div>
      <div
        className={cn(
          "grotesk mt-2 text-[30px] font-bold leading-none tracking-tight tabular-nums",
          TONE_TEXT[tone],
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-2 text-[11.5px] font-medium text-muted-foreground">{sub}</div>}
    </Card>
  );
}
