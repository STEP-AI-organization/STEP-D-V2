"use client";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Youtube } from "lucide-react";
import { useEffect, useState } from "react";
import type { YouTubeChannelInfo } from "@/lib/data/api";
import { fetchYouTubeChannels, getYouTubeAuthUrl, deleteYouTubeChannel } from "@/lib/data/api";
import { ChannelAnalysis } from "@/components/channel-analysis";

export default function PublishChannelsPage() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);

  const loadChannels = async () => {
    try {
      const chs = await fetchYouTubeChannels();
      setChannels(chs);
    } catch {
      // Server offline — ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadChannels();

    // We come back here after the OAuth round trip (return=/publish-channels). Show the result,
    // then strip the params so a refresh doesn't repeat the banner. Reading
    // location.search directly avoids the <Suspense> that useSearchParams would force.
    const params = new URLSearchParams(window.location.search);
    if (params.get("success")) {
      setBanner(`✅ "${params.get("channelName") ?? "채널"}" 연결 완료 · 분석을 시작했습니다`);
    } else if (params.get("error")) {
      setBanner(`❌ 채널 연결 실패: ${decodeURIComponent(params.get("error")!)}`);
    }
    if (params.get("success") || params.get("error")) {
      window.history.replaceState(null, "", "/publish-channels");
    }
  }, []);

  const handleDelete = async (channelId: string) => {
    if (!confirm("이 YouTube 채널 연결을 해제하시겠습니까?")) return;
    try {
      await deleteYouTubeChannel(channelId);
      setChannels((prev) => prev.filter((c) => c.channelId !== channelId));
    } catch (err) {
      alert("삭제에 실패했습니다.");
    }
  };

  return (
    <>
      <PageHeader
        title="배포채널"
        description="콘텐츠를 배포·분석할 채널을 연동하고 관리합니다 (YouTube 등)."
      />

      {/* YouTube 채널 연동 */}
      <section className="mb-10">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">YouTube 채널 연동</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              <b className="text-foreground">분석·수익 연결</b>은 조회수·시청시간·<b className="text-foreground">수익(수익화 채널)</b>을 읽어옵니다.{" "}
              <b className="text-foreground">업로드 채널</b>은 클립을 이 채널로 배포합니다.
              같은 채널을 둘 다 쓰려면 각각 한 번씩 연결하세요(토큰이 서로 덮어씁니다).
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              onClick={() => { window.location.href = getYouTubeAuthUrl(undefined, "analytics", "/publish-channels"); }}
            >
              + 분석·수익 연결
            </Button>
            <Button
              onClick={() => { window.location.href = getYouTubeAuthUrl(undefined, "publish", "/publish-channels"); }}
            >
              + 업로드 채널
            </Button>
          </div>
        </div>

        {banner && (
          <div className="mb-4 rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-foreground">
            {banner}
          </div>
        )}

        {loading ? (
          <div className="text-muted-foreground text-sm">불러오는 중...</div>
        ) : channels.length === 0 ? (
          <Card className="p-8">
            <EmptyState
              icon={Youtube}
              title="연동된 YouTube 채널이 없습니다"
              description="위 버튼으로 채널을 연결하세요 — 분석·수익은 '분석·수익 연결', 클립 배포는 '업로드 채널'. 외부 협력자는 /register 페이지에서 직접 등록할 수 있습니다."
            />
          </Card>
        ) : (
          <div className="grid gap-3">
            {channels.map((ch) => (
              <Card key={ch.channelId} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {ch.thumbnail ? (
                      <img src={ch.thumbnail} alt={ch.channelName} className="w-10 h-10 rounded-full" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-sm">
                        {ch.channelName.charAt(0)}
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-medium text-foreground">{ch.channelName}</div>
                      <div className="text-xs text-muted-foreground">
                        구독자 {ch.subscribers ?? "?"}명
                        {ch.connectedAt && ` · ${new Date(Number(ch.connectedAt)).toLocaleDateString("ko-KR")} 연결`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-1 rounded-full ${
                      ch.status === "active"
                        ? "bg-emerald-900/40 text-emerald-400"
                        : ch.status === "revoked"
                          ? "bg-amber-900/40 text-amber-400"
                          : "bg-red-900/40 text-red-400"
                    }`}>
                      {ch.status === "active" ? "활성" : ch.status === "revoked" ? "재연결 필요" : "오류"}
                    </span>
                    <button
                      onClick={() => handleDelete(ch.channelId)}
                      className="text-xs text-muted-foreground hover:text-status-error transition px-2 py-1"
                    >
                      삭제
                    </button>
                  </div>
                </div>

                <ChannelAnalysis channelId={ch.channelId} />
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
