"use client";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Youtube } from "lucide-react";
import { useEffect, useState } from "react";
import type { YouTubeChannelInfo } from "@/lib/data/api";
import { fetchYouTubeChannels, getYouTubeAuthUrl, deleteYouTubeChannel } from "@/lib/data/api";
import { ChannelAnalysis } from "@/components/channel-analysis";
import { DISTRIBUTION_CHANNELS, type DistributionChannel } from "@/lib/constants";

/**
 * 배포채널 — 각 플랫폼 카드 + YouTube만 실제 OAuth 배선. 나머지(Instagram/Facebook/TikTok/SMR)는
 * UI 슬롯만 있고 백엔드 미구현 상태로 "준비 중" 표시. 새 채널 추가 흐름:
 *  1) lib/constants.ts DISTRIBUTION_CHANNELS 에 { label, icon, status } 항목 추가
 *  2) apps/web/public/channel-icons/<id>.png 배치 (공식 favicon 권장)
 *  3) 서버 /api/distributions/publish 스위치 + 필요 시 OAuth 라우트
 */

/** 채널별 안내 문구 · 연결 방식. 백엔드 배선 시 여기서 auth URL 훅업. */
const CHANNEL_INFO: Record<DistributionChannel, { desc: string; note?: string }> = {
  youtube: {
    desc: "OAuth로 채널 연결. 분석·수익은 '분석·수익 연결', 배포는 '업로드 채널' 옵션.",
  },
  instagram: {
    desc: "Meta Business 계정으로 인스타그램 비즈니스 계정 연결 (Reels 배포용).",
    note: "백엔드 배선 준비 중",
  },
  facebook: {
    desc: "Meta Business 계정으로 Facebook 페이지 연결.",
    note: "백엔드 배선 준비 중",
  },
  tiktok: {
    desc: "TikTok for Business로 계정 연결 (Content Posting API).",
    note: "백엔드 배선 준비 중",
  },
  smr: {
    desc: "네이버 SMR은 내부 피드 배포 방식으로, 별도 OAuth 연결이 없습니다.",
    note: "제휴 배급 · 프로그램 단위 설정",
  },
};

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
      setBanner(`"${params.get("channelName") ?? "채널"}" 연결 완료 · 분석을 시작했습니다`);
    } else if (params.get("error")) {
      setBanner(`채널 연결 실패: ${decodeURIComponent(params.get("error")!)}`);
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
    } catch {
      alert("삭제에 실패했습니다.");
    }
  };

  const ids = Object.keys(DISTRIBUTION_CHANNELS) as DistributionChannel[];

  return (
    <>
      <PageHeader
        eyebrow="연동 채널 관리"
        title="배포채널"
        description="콘텐츠를 배포할 플랫폼별 계정을 연결합니다. YouTube만 실제 배포 가능, 나머지는 준비 중."
      />

      {banner && (
        <div className="mb-6 rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-foreground">
          {banner}
        </div>
      )}

      {/* 플랫폼 개요 그리드 — 모든 채널을 한눈에. YouTube만 클릭 가능. */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">플랫폼</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ids.map((id) => {
            const meta = DISTRIBUTION_CHANNELS[id];
            const info = CHANNEL_INFO[id];
            const isYouTube = id === "youtube";
            const connectedCount = isYouTube ? channels.length : 0;
            return (
              <Card key={id} className="p-4">
                <div className="mb-3 flex items-start gap-3">
                  {meta.icon ? (
                    <img
                      src={meta.icon}
                      alt={meta.label}
                      className="size-10 rounded-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex size-10 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                      {meta.label.charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                      {meta.status === "implemented" ? (
                        connectedCount > 0 ? (
                          <StatusBadge tone="done">{connectedCount}개 연결</StatusBadge>
                        ) : (
                          <StatusBadge tone="idle">미연결</StatusBadge>
                        )
                      ) : (
                        <StatusBadge tone="warn">준비 중</StatusBadge>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{info.desc}</p>
                    {info.note && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground/70">{info.note}</p>
                    )}
                  </div>
                </div>
                {isYouTube ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        window.location.href = getYouTubeAuthUrl(
                          undefined,
                          "analytics",
                          "/publish-channels",
                        );
                      }}
                    >
                      + 분석·수익 연결
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        window.location.href = getYouTubeAuthUrl(
                          undefined,
                          "publish",
                          "/publish-channels",
                        );
                      }}
                    >
                      + 업로드 채널
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" disabled className="w-full">
                    연결 대기
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      </section>

      {/* YouTube: 연결된 채널 상세 목록 */}
      <section className="mb-10">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">YouTube 연결 채널</h2>
          <span className="text-[11px] text-muted-foreground/70">
            (같은 채널을 분석·업로드 둘 다 쓰려면 각각 한 번씩 연결 — 토큰이 서로 덮어씀)
          </span>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground">불러오는 중...</div>
        ) : channels.length === 0 ? (
          <Card className="p-8">
            <EmptyState
              icon={Youtube}
              title="연동된 YouTube 채널이 없습니다"
              description="위 카드의 '분석·수익 연결' 또는 '업로드 채널' 버튼으로 붙이세요. 외부 협력자는 /register 페이지에서 직접 등록할 수 있습니다."
            />
          </Card>
        ) : (
          <div className="grid gap-3">
            {channels.map((ch) => (
              <Card key={ch.channelId} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {ch.thumbnail ? (
                      <img src={ch.thumbnail} alt={ch.channelName} className="size-10 rounded-full" />
                    ) : (
                      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                        {ch.channelName.charAt(0)}
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-medium text-foreground">{ch.channelName}</div>
                      <div className="text-xs text-muted-foreground">
                        구독자 {ch.subscribers ?? "?"}명
                        {ch.connectedAt &&
                          ` · ${new Date(Number(ch.connectedAt)).toLocaleDateString("ko-KR")} 연결`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge
                      tone={ch.status === "active" ? "done" : ch.status === "revoked" ? "warn" : "error"}
                    >
                      {ch.status === "active" ? "활성" : ch.status === "revoked" ? "재연결 필요" : "오류"}
                    </StatusBadge>
                    <button
                      onClick={() => handleDelete(ch.channelId)}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-status-error"
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
