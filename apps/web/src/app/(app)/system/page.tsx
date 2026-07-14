"use client";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useEffect, useState } from "react";
import type { YouTubeChannelInfo } from "@/lib/data/api";
import { fetchYouTubeChannels, getYouTubeAuthUrl, deleteYouTubeChannel } from "@/lib/data/api";

export default function SystemPage() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [loading, setLoading] = useState(true);

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
        title="시스템"
        description="파이프라인 헬스, 채널 연동(YouTube/Meta), SMR 피드, 계정·역할, 파일 관리."
      />

      {/* YouTube 채널 연동 */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">YouTube 채널 연동</h2>
          <Button
            onClick={() => { window.open(getYouTubeAuthUrl(), "_blank"); }}
            className="bg-white text-zinc-900 hover:bg-zinc-100"
          >
            + 채널 추가
          </Button>
        </div>

        {loading ? (
          <div className="text-zinc-500 text-sm">불러오는 중...</div>
        ) : channels.length === 0 ? (
          <Card className="p-8">
            <EmptyState
              icon={<div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-500">YT</div>}
              title="연동된 YouTube 채널이 없습니다"
              description="'채널 추가' 버튼으로 YouTube 채널을 연결하세요. 외부 협력자는 /register 페이지에서 직접 등록할 수 있습니다."
            />
          </Card>
        ) : (
          <div className="grid gap-3">
            {channels.map((ch) => (
              <Card key={ch.channelId} className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  {ch.thumbnail ? (
                    <img src={ch.thumbnail} alt={ch.channelName} className="w-10 h-10 rounded-full" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-400 text-sm">
                      {ch.channelName.charAt(0)}
                    </div>
                  )}
                  <div>
                    <div className="text-sm font-medium text-white">{ch.channelName}</div>
                    <div className="text-xs text-zinc-500">
                      구독자 {ch.subscribers ?? "?"}명
                      {ch.connectedAt && ` · ${new Date(ch.connectedAt).toLocaleDateString("ko-KR")} 연결`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded-full ${
                    ch.status === "active"
                      ? "bg-emerald-900/40 text-emerald-400"
                      : "bg-red-900/40 text-red-400"
                  }`}>
                    {ch.status === "active" ? "활성" : "오류"}
                  </span>
                  <button
                    onClick={() => handleDelete(ch.channelId)}
                    className="text-xs text-zinc-500 hover:text-red-400 transition px-2 py-1"
                  >
                    삭제
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
