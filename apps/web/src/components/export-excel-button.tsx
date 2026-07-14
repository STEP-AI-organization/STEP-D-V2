"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { exportDistributionExcel } from "@/lib/export/distribution-excel";

/**
 * "엑셀 내보내기" — builds the distribution-records workbook client-side (exceljs,
 * dynamically imported) and downloads it. Reproduces STEPD's YouTube-metadata
 * report format per program plus an all-channel 배포 기록 sheet.
 */
export function ExportExcelButton({ className }: { className?: string }) {
  const { programs, episodes, clips } = useAppData();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function onExport() {
    if (busy) return;
    setBusy(true);
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const res = await exportDistributionExcel({ programs, episodes, clips }, stamp);
      toast({
        title: "엑셀 내보내기 완료",
        description: `${res.filename} · 배포 ${res.recordRows}건 · YouTube 메타 ${res.youtubeRows}건`,
        tone: "done",
      });
    } catch (err) {
      toast({
        title: "내보내기 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={onExport} disabled={busy} className={className}>
      {busy ? <Loader2 className="animate-spin" /> : <Download />}
      엑셀 내보내기
    </Button>
  );
}
