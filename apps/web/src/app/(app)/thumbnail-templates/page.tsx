"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/data/api";
import { PageActions } from "@/components/shell/page-actions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Loader2, Trash2, Upload, Sparkles, Image as ImageIcon, Youtube } from "lucide-react";
import { useToast } from "@/components/ui/toast";

interface RefItem {
  id: string;
  path: string;
  cleaned_path?: string;
  _analyzed?: boolean;
  person_count?: number;
  mood?: string;
  composition?: string;
  program?: string;
  custom_tags?: string[];
  user_note?: string;
  description?: string;
  caption_style?: string;
  uploaded_at?: string;
  source?: { videoId?: string; title?: string; viewCount?: string | number };
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

/** 배치 라우트는 개별 실패를 삼키고 항상 200 을 준다 — results 를 직접 세야 진실이 나온다. */
interface BatchResult {
  processed: number;
  note?: string;
  results?: { id: string; ok: boolean; error?: string }[];
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Vision 분석·사전 가공은 파이썬 스크립트라 GCS(Cloud Run) 모드에서는 서버가 501 을 준다. */
const LOCAL_ONLY_HINT = "이 서버에서는 실행할 수 없습니다 (501) — 로컬 워커에서만 됩니다";

export default function ThumbnailTemplatesPage() {
  const { toast: push } = useToast();
  const [items, setItems] = useState<RefItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<RefItem | null>(null);
  // 가공본을 보고 있는 카드들. 서버는 ?variant=cleaned 로 이미 열어 뒀는데 화면이 안 불렀다.
  const [cleanedOn, setCleanedOn] = useState<Set<string>>(new Set());
  // 서버가 GCS 모드면 Vision 분석·사전 가공 스크립트를 못 돌린다(501). 응답 전에는 모드를
  // 알 방법이 없어서, 한 번 501 을 받으면 관련 버튼을 잠가 헛클릭을 막는다.
  const [localOnly, setLocalOnly] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const failMessage = useCallback((e: unknown) => {
    const msg = errMessage(e);
    if (msg.startsWith("501")) setLocalOnly(true);
    return msg;
  }, []);

  /** 배치는 전건 실패도 200 으로 돌아온다 — 성공/실패를 갈라서 말한다. */
  const reportBatch = useCallback((label: string, r: BatchResult) => {
    const results = r.results ?? [];
    if (!results.length) {
      push({ tone: "idle", title: `전체 ${label}: 대상 없음`, description: r.note });
      return;
    }
    const failed = results.filter((x) => !x.ok);
    const firstError = failed[0]?.error ?? "";
    if (failed.length === results.length) {
      push({ tone: "error", title: `전체 ${label} 실패 (${failed.length}건)`, description: firstError });
      return;
    }
    if (failed.length) {
      push({
        tone: "warn",
        title: `전체 ${label}: 성공 ${results.length - failed.length} · 실패 ${failed.length}`,
        description: firstError,
      });
      return;
    }
    push({ tone: "done", title: `전체 ${label}: ${results.length}개 처리` });
  }, [push]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { items } = await api<{ items: RefItem[] }>("/thumbnail-refs");
      setItems(items || []);
    } catch (e: any) {
      push({ tone: "error", title: "로드 실패", description: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => { refresh(); }, [refresh]);

  const onUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      try {
        const { item } = await api<{ item: RefItem }>("/thumbnail-refs", {
          method: "POST", body: form,
        });
        push({ tone: "done", title: `업로드: ${item.id}` });
      } catch (e: any) {
        push({ tone: "error", title: "업로드 실패", description: String(e?.message || e) });
      }
    }
    refresh();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onUpload(e.dataTransfer.files);
  };

  const onDelete = async (id: string) => {
    if (!confirm(`${id} 삭제?`)) return;
    setBusyId(id);
    try {
      await api(`/thumbnail-refs/${id}`, { method: "DELETE" });
      push({ tone: "done", title: `삭제: ${id}` });
      refresh();
    } catch (e: any) {
      push({ tone: "error", title: "삭제 실패", description: String(e?.message || e) });
    } finally {
      setBusyId(null);
    }
  };

  const onAnalyze = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/thumbnail-refs/${id}/analyze`, { method: "POST" });
      push({ tone: "done", title: `분석 완료: ${id}` });
      refresh();
    } catch (e) {
      push({ tone: "error", title: "분석 실패", description: failMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  const onPreprocess = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/thumbnail-refs/${id}/preprocess`, { method: "POST" });
      push({ tone: "done", title: `사전 가공 완료: ${id}` });
      refresh();
    } catch (e) {
      push({ tone: "error", title: "가공 실패", description: failMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  const onSave = async (patch: Partial<RefItem>) => {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      await api(`/thumbnail-refs/${editing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      push({ tone: "done", title: `저장: ${editing.id}` });
      setEditing(null);
      refresh();
    } catch (e: any) {
      push({ tone: "error", title: "저장 실패", description: String(e?.message || e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <PageActions>
        <Button variant="outline" disabled={localOnly} title={localOnly ? LOCAL_ONLY_HINT : undefined}
                onClick={async () => {
          // 서버가 analyze 는 한 번만 돌린다(스크립트 자체가 전체 스캔) — 라벨도 그렇게 적었다.
          if (!confirm("미분석 template 을 스캔해 Vision 분석 (수십 초 소요)?")) return;
          try {
            const r = await api<BatchResult>("/thumbnail-refs/batch/analyze", { method: "POST" });
            reportBatch("분석", r);
            refresh();
          } catch (e) {
            push({ tone: "error", title: "분석 실패", description: failMessage(e) });
          }
        }}>
          <Sparkles className="w-4 h-4 mr-2" /> 전체 분석 (1회 스캔)
        </Button>
        <Button variant="outline" disabled={localOnly} title={localOnly ? LOCAL_ONLY_HINT : undefined}
                onClick={async () => {
          if (!confirm("모든 미가공 template 사전 가공 (수십 초/개 소요)?")) return;
          try {
            const r = await api<BatchResult>("/thumbnail-refs/batch/preprocess", { method: "POST" });
            reportBatch("가공", r);
            refresh();
          } catch (e) {
            push({ tone: "error", title: "가공 실패", description: failMessage(e) });
          }
        }}>
          <Sparkles className="w-4 h-4 mr-2" /> 전체 가공
        </Button>
        <Button variant="outline" onClick={async () => {
          const channelId = prompt("YouTube channelId (동기화된 채널)");
          if (!channelId) return;
          const program = prompt("프로그램 태그 (선택 · 비면 global)") || "";
          try {
            const r = await api<{ added: number }>("/thumbnail-refs/import-youtube", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ channelId, program, max: 6 }),
            });
            push({ tone: "done", title: `YouTube 수집: ${r.added}개 추가` });
            refresh();
          } catch (e: any) {
            push({ tone: "error", title: "수집 실패", description: String(e?.message || e) });
          }
        }}>
          <Youtube className="w-4 h-4 mr-2" /> YouTube 자동 수집
        </Button>
        <Button onClick={() => fileRef.current?.click()}>
          <Upload className="w-4 h-4 mr-2" /> 업로드
        </Button>
      </PageActions>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple
             className="hidden" onChange={(e) => onUpload(e.target.files)} />

      {localOnly && (
        <div className="rounded-md border border-status-warn/40 bg-muted px-3 py-2 text-xs text-muted-foreground">
          이 서버는 Vision 분석·사전 가공을 실행할 수 없습니다(501). 업로드·태그 편집·삭제는 그대로 됩니다.
          분석·가공은 서로 다른 스크립트라 로컬 워커에서 각각 돌려야 합니다 —
          분석: <span className="font-mono">python scripts/thumbnail_reference_manifest.py</span>{" "}
          (전체 스캔 · 인자 없음) · 가공: <span className="font-mono">python scripts/thumbnail_preprocess_template.py &lt;id&gt;</span>
        </div>
      )}

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="min-h-[200px] border-2 border-dashed border-border rounded-lg p-4"
      >
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={ImageIcon as any} title="템플릿 없음"
                      description="이 영역에 이미지를 드래그하거나 위 업로드 버튼" />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {items.map((item) => (
              <Card key={item.id} className="p-3 space-y-2">
                <div className="aspect-video bg-muted rounded overflow-hidden">
                  <img
                    src={`${API_BASE}/thumbnail-refs/${item.id}/image${cleanedOn.has(item.id) ? "?variant=cleaned" : ""}`}
                    alt={item.id}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="text-xs font-mono truncate">{item.id}</div>
                <div className="flex flex-wrap gap-1">
                  {item._analyzed ? (
                    <>
                      {item.person_count != null && <Badge variant="secondary">{item.person_count}인</Badge>}
                      {item.mood && <Badge variant="secondary">{item.mood}</Badge>}
                      {item.composition && <Badge variant="outline" className="text-[10px]">{item.composition}</Badge>}
                    </>
                  ) : (
                    <Badge variant="outline">미분석</Badge>
                  )}
                  {item.program && <Badge>{item.program}</Badge>}
                  {(item.custom_tags || []).slice(0, 3).map((t) => (
                    <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
                  ))}
                </div>
                {item.description && (
                  <div className="text-xs text-muted-foreground line-clamp-2">{item.description}</div>
                )}
                {item.user_note && (
                  <div className="text-xs text-muted-foreground line-clamp-1" title={item.user_note}>
                    메모 · {item.user_note}
                  </div>
                )}
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="flex-1"
                          onClick={() => setEditing(item)}>편집</Button>
                  {!item._analyzed && (
                    <Button size="sm" variant="outline" disabled={busyId === item.id || localOnly}
                            onClick={() => onAnalyze(item.id)}
                            title={localOnly ? LOCAL_ONLY_HINT : "Vision 분석"}>
                      {busyId === item.id
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Sparkles className="w-3 h-3" />}
                    </Button>
                  )}
                  <Button size="sm" variant={item.cleaned_path ? "outline" : "default"}
                          disabled={busyId === item.id || localOnly}
                          onClick={() => onPreprocess(item.id)}
                          title={localOnly ? LOCAL_ONLY_HINT : "사전 가공 (텍스트→슬롯 라벨·얼굴→실루엣)"}>
                    {busyId === item.id
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <span className="text-[10px]">{item.cleaned_path ? "재가공" : "가공"}</span>}
                  </Button>
                  <Button size="sm" variant="outline"
                          disabled={busyId === item.id}
                          onClick={() => onDelete(item.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
                {item.cleaned_path && (
                  <button type="button"
                          className="text-[10px] text-emerald-500 underline underline-offset-2"
                          onClick={() => setCleanedOn((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                            return next;
                          })}>
                    ✓ cleaned template — {cleanedOn.has(item.id) ? "원본 보기" : "가공본 보기"}
                  </button>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <EditDialog item={editing} onClose={() => setEditing(null)} onSave={onSave} busy={busyId === editing.id} />
      )}
    </div>
  );
}

function EditDialog({ item, onClose, onSave, busy }: {
  item: RefItem;
  onClose: () => void;
  onSave: (patch: Partial<RefItem>) => void;
  busy: boolean;
}) {
  const [program, setProgram] = useState(item.program || "");
  const [tags, setTags] = useState((item.custom_tags || []).join(", "));
  const [note, setNote] = useState(item.user_note || "");
  // 가공본이 있으면 그쪽을 먼저 보여준다 — 가공 결과를 사람이 볼 데가 여기밖에 없다.
  const [showCleaned, setShowCleaned] = useState(Boolean(item.cleaned_path));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
         onClick={onClose}>
      <Card className="max-w-md w-full p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <img src={`${API_BASE}/thumbnail-refs/${item.id}/image${showCleaned && item.cleaned_path ? "?variant=cleaned" : ""}`}
               className="w-24 h-14 object-cover rounded" alt="" />
          <div>
            <div className="font-mono text-sm">{item.id}</div>
            {item.description && <div className="text-xs text-muted-foreground">{item.description}</div>}
            {item.cleaned_path && (
              <button type="button" className="text-xs text-emerald-500 underline underline-offset-2"
                      onClick={() => setShowCleaned((v) => !v)}>
                {showCleaned ? "원본 보기" : "가공본 보기"}
              </button>
            )}
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">프로그램 (비면 global)</label>
          <input value={program} onChange={(e) => setProgram(e.target.value)}
                 className="w-full mt-1 px-3 py-2 bg-muted rounded text-sm"
                 placeholder="예: 환승연애4" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">사용자 태그 (콤마 구분)</label>
          <input value={tags} onChange={(e) => setTags(e.target.value)}
                 className="w-full mt-1 px-3 py-2 bg-muted rounded text-sm"
                 placeholder="예: 연애, 리액션" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">메모</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)}
                    className="w-full mt-1 px-3 py-2 bg-muted rounded text-sm h-20" />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>취소</Button>
          {/* 빈 문자열도 그대로 보낸다 — 조건부로 빼면 메모를 지워도 서버 값이 살아남는다. */}
          <Button disabled={busy} onClick={() => onSave({
            program: program.trim(),
            custom_tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
            user_note: note,
          })}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "저장"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
