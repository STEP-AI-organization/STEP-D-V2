"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/data/api";
import { PageHeader } from "@/components/ui/page-header";
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

export default function ThumbnailTemplatesPage() {
  const { toast: push } = useToast();
  const [items, setItems] = useState<RefItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<RefItem | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    } catch (e: any) {
      push({ tone: "error", title: "분석 실패", description: String(e?.message || e) });
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
    } catch (e: any) {
      push({ tone: "error", title: "가공 실패", description: String(e?.message || e) });
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
    <div className="p-6 space-y-6">
      <PageHeader
        title="썸네일 템플릿"
        description="swap 파이프라인이 사용할 방송사 완성작 · 드래그 업로드 · 태그 편집"
        actions={
          <div className="flex gap-2">
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
          </div>
        }
      />
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple
             className="hidden" onChange={(e) => onUpload(e.target.files)} />

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
                    src={`${API_BASE}/thumbnail-refs/${item.id}/image`}
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
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="flex-1"
                          onClick={() => setEditing(item)}>편집</Button>
                  {!item._analyzed && (
                    <Button size="sm" variant="outline" disabled={busyId === item.id}
                            onClick={() => onAnalyze(item.id)} title="Vision 분석">
                      {busyId === item.id
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Sparkles className="w-3 h-3" />}
                    </Button>
                  )}
                  <Button size="sm" variant={item.cleaned_path ? "outline" : "default"}
                          disabled={busyId === item.id}
                          onClick={() => onPreprocess(item.id)}
                          title="사전 가공 (텍스트→슬롯 라벨·얼굴→실루엣)">
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
                  <div className="text-[10px] text-emerald-500">✓ cleaned template</div>
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
  const [note, setNote] = useState((item as any).user_note || "");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
         onClick={onClose}>
      <Card className="max-w-md w-full p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <img src={`${API_BASE}/thumbnail-refs/${item.id}/image`}
               className="w-24 h-14 object-cover rounded" alt="" />
          <div>
            <div className="font-mono text-sm">{item.id}</div>
            {item.description && <div className="text-xs text-muted-foreground">{item.description}</div>}
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
          <Button disabled={busy} onClick={() => onSave({
            program: program.trim(),
            custom_tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
            ...(note ? { user_note: note } as any : {}),
          })}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "저장"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
