"use client";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Youtube } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { YouTubeChannelInfo, MetaAccountInfo, TikTokAccountInfo } from "@/lib/data/api";
import {
  fetchYouTubeChannels,
  getYouTubeAuthUrl,
  deleteYouTubeChannel,
  fetchMetaAccounts,
  getMetaAuthUrl,
  deleteMetaAccount,
  fetchTikTokAccounts,
  getTikTokAuthUrl,
  deleteTikTokAccount,
  fetchChannelRules,
} from "@/lib/data/api";
import { ChannelRuleDialog } from "@/components/publish/channel-rule-dialog";
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
    desc: "Meta 통합 연결 — Facebook Page + 연결된 Instagram Business 한 번에.",
    note: "아래 '페이스북 · 인스타그램' 카드에서 연결",
  },
  facebook: {
    desc: "Meta 통합 연결 — Facebook Page + 연결된 Instagram Business 한 번에.",
    note: "아래 '페이스북 · 인스타그램' 카드에서 연결",
  },
  tiktok: {
    desc: "TikTok Login Kit + Content Posting API 로 계정 연결.",
    note: "아래 'TikTok' 카드에서 연결",
  },
  smr: {
    desc: "네이버 SMR은 내부 피드 배포 방식으로, 별도 OAuth 연결이 없습니다.",
    note: "제휴 배급 · 프로그램 단위 설정",
  },
};

export default function PublishChannelsPage() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  // 배포 규칙이 붙은 채널 — 연결돼 있어도 규칙이 없으면 배포가 안 된다.
  const [ruledIds, setRuledIds] = useState<Set<string>>(new Set());
  const [ruleFor, setRuleFor] = useState<{ id: string; name: string } | null>(null);

  const loadRules = useCallback(async () => {
    try {
      const rules = await fetchChannelRules();
      setRuledIds(new Set(rules.filter((r) => r.platform === "youtube").map((r) => r.accountId)));
    } catch { /* 규칙을 못 읽어도 연결 목록은 보여야 한다 */ }
  }, []);
  useEffect(() => { void loadRules(); }, [loadRules]);
  const [metaAccounts, setMetaAccounts] = useState<MetaAccountInfo[]>([]);
  const [tiktokAccounts, setTiktokAccounts] = useState<TikTokAccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);

  const loadAll = async () => {
    try {
      const [chs, ma, tt] = await Promise.all([
        fetchYouTubeChannels().catch(() => [] as YouTubeChannelInfo[]),
        fetchMetaAccounts().catch(() => [] as MetaAccountInfo[]),
        fetchTikTokAccounts().catch(() => [] as TikTokAccountInfo[]),
      ]);
      setChannels(chs);
      setMetaAccounts(ma);
      setTiktokAccounts(tt);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();

    // Both YouTube and Meta callbacks land here (return=/publish-channels). Show the banner,
    // then strip the params so a refresh doesn't repeat it. Reading location.search directly
    // avoids the <Suspense> that useSearchParams would force.
    const params = new URLSearchParams(window.location.search);
    if (params.get("success")) {
      setBanner(`"${params.get("channelName") ?? "채널"}" 연결 완료 · 분석을 시작했습니다`);
    } else if (params.get("error")) {
      setBanner(`채널 연결 실패: ${decodeURIComponent(params.get("error")!)}`);
    } else if (params.get("meta_success")) {
      const n = params.get("meta_count") ?? "0";
      setBanner(`Meta 연결 완료 · ${n}개 페이지 저장됨`);
    } else if (params.get("meta_error")) {
      setBanner(`Meta 연결 실패: ${decodeURIComponent(params.get("meta_error")!)}`);
    } else if (params.get("tiktok_success")) {
      setBanner(`TikTok 연결 완료 · "${decodeURIComponent(params.get("tiktok_name") ?? "")}"`);
    } else if (params.get("tiktok_error")) {
      setBanner(`TikTok 연결 실패: ${decodeURIComponent(params.get("tiktok_error")!)}`);
    }
    if (
      params.get("success") || params.get("error") ||
      params.get("meta_success") || params.get("meta_error") ||
      params.get("tiktok_success") || params.get("tiktok_error")
    ) {
      window.history.replaceState(null, "", "/publish-channels");
    }
  }, []);

  const handleDeleteMeta = async (publicId: string) => {
    if (!confirm("이 Meta 페이지 연결을 해제하시겠습니까?")) return;
    try {
      await deleteMetaAccount(publicId);
      setMetaAccounts((prev) => prev.filter((a) => a.publicId !== publicId));
    } catch {
      alert("삭제에 실패했습니다.");
    }
  };

  const handleDeleteTiktok = async (publicId: string) => {
    if (!confirm("이 TikTok 계정 연결을 해제하시겠습니까?")) return;
    try {
      await deleteTikTokAccount(publicId);
      setTiktokAccounts((prev) => prev.filter((a) => a.publicId !== publicId));
    } catch {
      alert("삭제에 실패했습니다.");
    }
  };

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

      {/* Meta: Facebook Page + Instagram Business (한 번 연결로 둘 다) */}
      <section className="mb-10">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">페이스북 · 인스타그램 연결</h2>
          <span className="text-[11px] text-muted-foreground/70">
            (Facebook Page 소유자로 로그인 · 연결된 Instagram Business 계정이 자동으로 함께 저장됨)
          </span>
        </div>

        <Card className="p-4 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              Facebook Page + 연결된 Instagram Business 계정을 한 번의 OAuth 로 등록합니다.
              같은 Meta 계정을 다시 클릭하면 최신 Page 목록으로 새로고침됩니다.
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  window.location.href = getMetaAuthUrl("/publish-channels", true);
                }}
              >
                권한 재요청
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  window.location.href = getMetaAuthUrl("/publish-channels");
                }}
              >
                + Meta 계정 연결
              </Button>
            </div>
          </div>
        </Card>

        {metaAccounts.length === 0 ? (
          <Card className="p-6">
            <div className="text-sm text-muted-foreground">
              연결된 Meta 페이지가 없습니다. 위 "+ Meta 계정 연결" 을 누르면
              관리하는 모든 Facebook Page 와 연결된 Instagram Business 계정이 저장됩니다.
            </div>
          </Card>
        ) : (
          <div className="grid gap-3">
            {metaAccounts.map((a) => (
              <Card key={a.publicId} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {a.pageProfilePictureUrl ? (
                      <img
                        src={a.pageProfilePictureUrl}
                        alt={a.pageName}
                        className="size-10 rounded-full"
                      />
                    ) : (
                      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                        {a.pageName.charAt(0)}
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-medium text-foreground">{a.pageName}</div>
                      <div className="text-xs text-muted-foreground">
                        FB Page ID {a.pageId}
                        {a.igUsername
                          ? ` · IG @${a.igUsername}`
                          : " · IG 미연결 (Page 설정에서 연결 필요)"}
                        {a.connectedAt &&
                          ` · ${new Date(Number(a.connectedAt)).toLocaleDateString("ko-KR")} 연결`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge tone={a.status === "active" ? "done" : "warn"}>
                      {a.status === "active" ? "활성" : a.status}
                    </StatusBadge>
                    <button
                      onClick={() => handleDeleteMeta(a.publicId)}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-status-error"
                    >
                      삭제
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* TikTok: Login Kit + Content Posting API */}
      <section className="mb-10">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">TikTok 연결 계정</h2>
          <span className="text-[11px] text-muted-foreground/70">
            (access token ~24h · refresh token ~365d · 업로드 전 자동 갱신)
          </span>
        </div>

        <Card className="p-4 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              TikTok Login Kit 로 계정을 연결합니다. Content Posting API 권한이 함께 요청됩니다.
            </div>
            <Button
              size="sm"
              onClick={() => {
                window.location.href = getTikTokAuthUrl("/publish-channels");
              }}
            >
              + TikTok 계정 연결
            </Button>
          </div>
        </Card>

        {tiktokAccounts.length === 0 ? (
          <Card className="p-6">
            <div className="text-sm text-muted-foreground">
              연결된 TikTok 계정이 없습니다. 위 "+ TikTok 계정 연결" 버튼으로 붙이세요.
            </div>
          </Card>
        ) : (
          <div className="grid gap-3">
            {tiktokAccounts.map((a) => (
              <Card key={a.publicId} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {a.avatarUrl ? (
                      <img src={a.avatarUrl} alt={a.displayName} className="size-10 rounded-full" />
                    ) : (
                      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                        {a.displayName.charAt(0)}
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-medium text-foreground">{a.displayName}</div>
                      <div className="text-xs text-muted-foreground">
                        {a.username ? `@${a.username} · ` : ""}
                        open_id {a.openId.slice(0, 8)}…
                        {a.connectedAt &&
                          ` · ${new Date(Number(a.connectedAt)).toLocaleDateString("ko-KR")} 연결`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge tone={a.status === "active" ? "done" : "warn"}>
                      {a.status === "active" ? "활성" : a.status}
                    </StatusBadge>
                    <button
                      onClick={() => handleDeleteTiktok(a.publicId)}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-status-error"
                    >
                      삭제
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
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
                    {/* 연결과 규칙은 다른 것이다 — 규칙이 없으면 배포 모달에 이 채널이 안 뜬다.
                        그래서 상태를 여기서 바로 보여주고, 여기서 바로 만들게 한다. */}
                    {ruledIds.has(ch.channelId) ? (
                      <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
                        배포 규칙 있음
                      </span>
                    ) : (
                      <span className="rounded-md border border-status-warn/40 bg-status-warn/10 px-2 py-1 text-[11px] text-status-warn">
                        배포 규칙 없음
                      </span>
                    )}
                    <button
                      onClick={() => setRuleFor({ id: ch.channelId, name: ch.channelName })}
                      className="rounded-md border border-border px-2 py-1 text-xs text-foreground transition hover:bg-accent/40"
                    >
                      배포 규칙
                    </button>
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

      {ruleFor && (
        <ChannelRuleDialog
          platform="youtube"
          accountId={ruleFor.id}
          accountLabel={ruleFor.name}
          onClose={() => setRuleFor(null)}
          onSaved={loadRules}
        />
      )}
    </>
  );
}
