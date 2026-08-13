"use client";

import { PageActions } from "@/components/shell/page-actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Youtube } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  YouTubeChannelInfo, MetaAccountInfo, InstagramAccountInfo, TikTokAccountInfo, NaverAccount,
} from "@/lib/data/api";
import {
  fetchYouTubeChannels,
  getYouTubeAuthUrl,
  deleteYouTubeChannel,
  disconnectYouTubeChannel,
  fetchMetaAccounts,
  getMetaAuthUrl,
  deleteMetaAccount,
  disconnectMetaAccount,
  fetchInstagramAccounts,
  getInstagramAuthUrl,
  deleteInstagramAccount,
  disconnectInstagramAccount,
  fetchTikTokAccounts,
  getTikTokAuthUrl,
  deleteTikTokAccount,
  disconnectTikTokAccount,
  fetchChannelRules,
} from "@/lib/data/api";
import { ChannelRuleDialog } from "@/components/publish/channel-rule-dialog";
import { NaverAccounts } from "@/components/publish/naver-accounts";
import { ChannelAnalysis } from "@/components/channel-analysis";
import {
  DISTRIBUTION_CHANNELS,
  type DistributionChannel,
  type DistributionChannelMeta,
} from "@/lib/constants";

/**
 * 배포채널 — 각 플랫폼 카드. YouTube·Facebook·Instagram·TikTok 은 OAuth 로 붙고,
 * **네이버(TV·클립)는 OAuth 가 없어** 로그인 세션을 등록하는 별도 섹션(NaverAccounts)에서 다룬다.
 * Instagram 은 2026-08-13 부터 Facebook(Meta OAuth)과 **분리** — IG 계정으로 직접
 * 로그인하는 비즈니스 로그인(/api/instagram/*)을 쓴다. Page 에 IG 를 연결해 둘 필요가 없다.
 * 새 채널 추가 흐름:
 *  1) lib/constants.ts DISTRIBUTION_CHANNELS 에 { label, icon, status } 항목 추가
 *     (status 는 DistributionChannelMeta 타입상 필수이지만, 이 화면의 배지는 더 이상 읽지 않는다
 *      — 실제 연결 계정 수와 OAuth 라우트 유무로만 판단한다)
 *  2) apps/web/public/channel-icons/<id>.png 배치 (공식 favicon 권장)
 *  3) 서버 /api/distributions/publish 스위치 + 필요 시 OAuth 라우트
 *
 * ⚠️ **연결됨 ≠ 파일이 올라간다.** 실제 업로드는 YouTube·네이버 클립·TikTok(게이트 ON 드래프트)이고,
 * Meta 는 배포 기록만 남는다(F4-3). 그래서 카드 안내 문구에서 그 사실을 분리해서 말한다.
 */

/** 채널별 안내 문구 · 연결 방식. */
const CHANNEL_INFO: Record<DistributionChannel, { desc: string; note?: string }> = {
  youtube: {
    desc: "OAuth로 채널 연결. 분석·수익은 '분석·수익 연결', 배포는 '업로드 채널' 옵션.",
  },
  instagram: {
    desc: "Instagram 비즈니스 로그인 — IG 프로페셔널 계정으로 직접 연결.",
    note: "연결해도 파일은 올라가지 않습니다 — 배포 기록만 남습니다",
  },
  facebook: {
    desc: "Meta OAuth 로 Facebook Page 연결.",
    note: "연결해도 파일은 올라가지 않습니다 — 배포 기록만 남습니다",
  },
  tiktok: {
    // 실 scope 는 user.info.basic 뿐 — 게시 권한은 TikTok 앱 심사 후에나 붙는다.
    desc: "TikTok Login Kit 로 계정 연결 — 기본 프로필 권한만 요청됩니다.",
    note: "업로드 게이트 OFF 상태에서는 기록만 남습니다 — ON 이면 틱톡 앱 받은함에 초안으로 올라갑니다",
  },
  naverclip: {
    desc: "세로 9:16 숏폼. OAuth 가 없어 로그인 세션으로 발행합니다 — 설명 10자 이상 · 카테고리 1·2차 필수.",
  },
};

/**
 * 연결과 규칙은 다른 것이다 — 단 규칙이 없어도 서버가 기본 규칙을 합성해 배포는 된다
 * (index.ts eligibility). 규칙은 다듬는 도구라서, 상태를 계정 카드에서 바로 보여주고
 * 필요할 때 거기서 바로 만들게 한다.
 */
function RuleControls({
  platform,
  accountId,
  accountLabel,
  ruled,
  unknown,
  onOpen,
  prefix = "",
}: {
  platform: string;
  accountId: string;
  accountLabel: string;
  ruled: boolean;
  /** 규칙 목록을 못 읽은 상태 — "규칙 없음"으로 단정하지 않는다. */
  unknown: boolean;
  onOpen: (v: { platform: string; id: string; name: string }) => void;
  /** 한 행에 규칙이 둘 이상일 때(예: FB Page + IG 계정) 구분용 접두어. */
  prefix?: string;
}) {
  return (
    <>
      {unknown ? (
        <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          {prefix}규칙 확인 실패
        </span>
      ) : ruled ? (
        <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          {prefix}배포 규칙 있음
        </span>
      ) : (
        // 규칙 없음은 경고가 아니다 — 서버가 기본 규칙으로 배포한다.
        <span
          className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground"
          title="커스텀 규칙이 없으면 서버 기본 규칙으로 배포됩니다 — 필요하면 옆 버튼으로 만드세요"
        >
          {prefix}기본 규칙 사용 중
        </span>
      )}
      <button
        onClick={() => onOpen({ platform, id: accountId, name: accountLabel })}
        className="rounded-md border border-border px-2 py-1 text-xs text-foreground transition hover:bg-accent/40"
        title={`${platform} · ${accountId}`}
      >
        {prefix}배포 규칙
      </button>
    </>
  );
}

export default function PublishChannelsPage() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  // 커스텀 배포 규칙이 붙은 계정 — 없어도 서버가 기본 규칙을 합성해 배포는 된다.
  // 키는 `${platform}:${accountId}` — YouTube 뿐 아니라 Meta·TikTok 도 같은 규칙 체계를 쓴다.
  const [ruledKeys, setRuledKeys] = useState<Set<string>>(new Set());
  const [rulesErr, setRulesErr] = useState<string | null>(null);
  const [ruleFor, setRuleFor] = useState<{ platform: string; id: string; name: string } | null>(null);

  const loadRules = useCallback(async () => {
    try {
      const rules = await fetchChannelRules();
      setRuledKeys(new Set(rules.map((r) => `${r.platform}:${r.accountId}`)));
      setRulesErr(null);
    } catch (err) {
      // 규칙을 못 읽어도 연결 목록은 보여야 한다. 단 "규칙 없음"이라고 단정하면 거짓말이다.
      setRulesErr(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void loadRules(); }, [loadRules]);
  const [metaAccounts, setMetaAccounts] = useState<MetaAccountInfo[]>([]);
  const [igAccounts, setIgAccounts] = useState<InstagramAccountInfo[]>([]);
  const [tiktokAccounts, setTiktokAccounts] = useState<TikTokAccountInfo[]>([]);
  // 네이버 계정은 아래 NaverAccounts 섹션이 소유한다. 여기서는 상단 카드의 숫자만 쓰려고
  // 사본을 받는다 — 두 곳에서 각자 fetch 하면 추가·삭제 후 숫자가 어긋난다.
  const [naverAccounts, setNaverAccounts] = useState<NaverAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ text: string; warn?: boolean } | null>(null);
  // .catch(() => []) 만 있으면 서버 다운이 "계정 없음"으로 둔갑한다 — 실패를 플랫폼별로
  // 기록해 빈 상태와 구분해서 그린다.
  const [loadFailed, setLoadFailed] = useState({ youtube: false, meta: false, ig: false, tiktok: false });

  const loadAll = async () => {
    const failed = { youtube: false, meta: false, ig: false, tiktok: false };
    try {
      const [chs, ma, ig, tt] = await Promise.all([
        fetchYouTubeChannels().catch(() => { failed.youtube = true; return [] as YouTubeChannelInfo[]; }),
        fetchMetaAccounts().catch(() => { failed.meta = true; return [] as MetaAccountInfo[]; }),
        fetchInstagramAccounts().catch(() => { failed.ig = true; return [] as InstagramAccountInfo[]; }),
        fetchTikTokAccounts().catch(() => { failed.tiktok = true; return [] as TikTokAccountInfo[]; }),
      ]);
      setChannels(chs);
      setMetaAccounts(ma);
      setIgAccounts(ig);
      setTiktokAccounts(tt);
      setLoadFailed(failed);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();

    // Both YouTube and Meta callbacks land here (return=/publish-channels). Show the banner,
    // then strip the params so a refresh doesn't repeat it. Reading location.search directly
    // avoids the <Suspense> that useSearchParams would force.
    // URLSearchParams.get() 이 이미 퍼센트 디코드를 마친 값을 준다 — 여기서
    // decodeURIComponent 를 또 부르면 "%" 든 에러 메시지에서 URIError 가 나
    // 이 useEffect 전체(파라미터 제거까지)가 죽는다.
    const params = new URLSearchParams(window.location.search);
    if (params.get("success")) {
      setBanner({ text: `"${params.get("channelName") ?? "채널"}" 연결 완료 · 분석을 시작했습니다` });
    } else if (params.get("error")) {
      setBanner({ text: `채널 연결 실패: ${params.get("error")!}`, warn: true });
    } else if (params.get("meta_success")) {
      const n = Number(params.get("meta_count") ?? "0");
      // 0개 저장은 성공이 아니다 — Page 없는 개인 계정으로 로그인하면 여기로 온다.
      setBanner(n > 0
        ? { text: `Facebook 연결 완료 · ${n}개 페이지 저장됨` }
        : { text: "Facebook 연결은 됐지만 저장된 Page 가 0개입니다 — Page 관리자 계정으로 로그인했는지 확인하세요.", warn: true });
    } else if (params.get("meta_error")) {
      setBanner({ text: `Facebook 연결 실패: ${params.get("meta_error")!}`, warn: true });
    } else if (params.get("ig_success")) {
      setBanner({ text: `Instagram 연결 완료 · @${params.get("ig_name") ?? ""}` });
    } else if (params.get("ig_error")) {
      setBanner({ text: `Instagram 연결 실패: ${params.get("ig_error")!}`, warn: true });
    } else if (params.get("tiktok_success")) {
      setBanner({ text: `TikTok 연결 완료 · "${params.get("tiktok_name") ?? ""}"` });
    } else if (params.get("tiktok_error")) {
      setBanner({ text: `TikTok 연결 실패: ${params.get("tiktok_error")!}`, warn: true });
    }
    if (
      params.get("success") || params.get("error") ||
      params.get("meta_success") || params.get("meta_error") ||
      params.get("ig_success") || params.get("ig_error") ||
      params.get("tiktok_success") || params.get("tiktok_error")
    ) {
      window.history.replaceState(null, "", "/publish-channels");
    }
  }, []);

  // 연동해제 ≠ 삭제. 해제는 토큰만 끊고 행·이력을 남긴다(재연동하면 이어서 씀).
  // 삭제는 행까지 지운다. 해제된 채널은 배포 대상에서 자동으로 빠진다(서버 판정).
  const handleDeleteMeta = async (publicId: string) => {
    if (!confirm("이 Meta 페이지를 완전히 삭제하시겠습니까? 연결 기록까지 지워집니다.\n(배포만 멈추려면 '연동해제'를 쓰세요)")) return;
    try {
      await deleteMetaAccount(publicId);
      setMetaAccounts((prev) => prev.filter((a) => a.publicId !== publicId));
    } catch {
      alert("삭제에 실패했습니다.");
    }
  };

  const handleDisconnectMeta = async (publicId: string) => {
    if (!confirm("이 Meta 페이지 연동을 해제하시겠습니까? 배포 대상에서 빠지고, 다시 연결하면 이어서 쓸 수 있습니다.")) return;
    try {
      await disconnectMetaAccount(publicId);
      setMetaAccounts((prev) => prev.map((a) => a.publicId === publicId ? { ...a, status: "disconnected" } : a));
    } catch {
      alert("연동해제에 실패했습니다.");
    }
  };

  const handleDeleteIg = async (publicId: string) => {
    if (!confirm("이 Instagram 계정을 완전히 삭제하시겠습니까? 연결 기록까지 지워집니다.\n(배포만 멈추려면 '연동해제'를 쓰세요)")) return;
    try {
      await deleteInstagramAccount(publicId);
      setIgAccounts((prev) => prev.filter((a) => a.publicId !== publicId));
    } catch {
      alert("삭제에 실패했습니다.");
    }
  };

  const handleDisconnectIg = async (publicId: string) => {
    if (!confirm("이 Instagram 계정 연동을 해제하시겠습니까? 배포 대상에서 빠지고, 다시 연결하면 이어서 쓸 수 있습니다.")) return;
    try {
      await disconnectInstagramAccount(publicId);
      setIgAccounts((prev) => prev.map((a) => a.publicId === publicId ? { ...a, status: "disconnected" } : a));
    } catch {
      alert("연동해제에 실패했습니다.");
    }
  };

  const handleDeleteTiktok = async (publicId: string) => {
    if (!confirm("이 TikTok 계정을 완전히 삭제하시겠습니까? 연결 기록까지 지워집니다.\n(배포만 멈추려면 '연동해제'를 쓰세요)")) return;
    try {
      await deleteTikTokAccount(publicId);
      setTiktokAccounts((prev) => prev.filter((a) => a.publicId !== publicId));
    } catch {
      alert("삭제에 실패했습니다.");
    }
  };

  const handleDisconnectTiktok = async (publicId: string) => {
    if (!confirm("이 TikTok 계정 연동을 해제하시겠습니까? 배포 대상에서 빠지고, 다시 연결하면 이어서 쓸 수 있습니다.")) return;
    try {
      await disconnectTikTokAccount(publicId);
      setTiktokAccounts((prev) => prev.map((a) => a.publicId === publicId ? { ...a, status: "disconnected" } : a));
    } catch {
      alert("연동해제에 실패했습니다.");
    }
  };

  const handleDelete = async (channelId: string) => {
    // 서버 삭제는 채널 행(연결 정보)만 지운다 — 수집된 애널리틱스 데이터 행은 남는다.
    if (!confirm("이 YouTube 채널을 완전히 삭제하시겠습니까? 채널 연결 정보가 지워지며, 다시 쓰려면 처음부터 재연결해야 합니다.\n(배포만 멈추려면 '연동해제'를 쓰세요)")) return;
    try {
      await deleteYouTubeChannel(channelId);
      setChannels((prev) => prev.filter((c) => c.channelId !== channelId));
    } catch {
      alert("삭제에 실패했습니다.");
    }
  };

  const handleDisconnect = async (channelId: string) => {
    if (!confirm("이 YouTube 채널 연동을 해제하시겠습니까? 배포 대상에서 빠지고, 이력은 남습니다. 다시 연결하면 이어서 씁니다.")) return;
    try {
      await disconnectYouTubeChannel(channelId);
      setChannels((prev) => prev.map((c) => c.channelId === channelId ? { ...c, status: "disconnected" } : c));
    } catch {
      alert("연동해제에 실패했습니다.");
    }
  };

  const ids = Object.keys(DISTRIBUTION_CHANNELS) as DistributionChannel[];

  return (
    <div className="mx-auto max-w-[1240px]">
      {banner && (
        <div
          className={
            banner.warn
              ? "mb-4 rounded-md border border-status-warn/40 bg-status-warn/10 px-4 py-3 text-sm text-status-warn"
              : "mb-4 rounded-md border border-border bg-muted px-4 py-3 text-sm text-foreground"
          }
        >
          {banner.text}
        </div>
      )}

      {/* 규칙 목록 화면(/channels)은 사이드바에 없다 — 유일한 진입점이 여기다. */}
      <PageActions>
        {rulesErr && (
          <span className="mr-auto text-[11px] text-status-warn">
            배포 규칙 목록을 불러오지 못했습니다 ({rulesErr}) — 아래 규칙 배지는 확인 불가입니다.
          </span>
        )}
        {/* 배포 규칙 목록 화면(/channels)은 제거됨 (2026-08-12 사용자 결정 — 규칙은 선택
            사항이고, 필요한 규칙 편집은 각 채널 행의 "배포 규칙" 버튼으로 충분하다). */}
      </PageActions>

      {/* 플랫폼 개요 그리드 — 모든 채널을 한눈에. YouTube·Meta(FB/IG)·TikTok 은 여기서 바로
          연결하고, 네이버는 절차가 달라(로그인 세션) 아래 전용 섹션으로 보낸다. */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">플랫폼</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ids.map((id) => {
            // 넓은 타입으로 받는다. 지금은 모든 채널에 아이콘이 있어서, 리터럴 타입 그대로
            // 두면 아래 아이콘 없음 폴백이 `never` 가 되어 컴파일이 깨진다 — 아이콘 없는
            // 채널이 다시 생겼을 때 폴백을 되살리느니 타입만 넓혀 둔다.
            const meta: DistributionChannelMeta = DISTRIBUTION_CHANNELS[id];
            const info = CHANNEL_INFO[id];
            const isYouTube = id === "youtube";
            // 지금 쓸 수 있는 계정만 센다 — disconnected·만료 행까지 세면 "N개 연결"인데
            // 배포는 안 되는 모순이 생긴다.
            const connectedCount =
              id === "youtube" ? channels.filter((c) => c.status === "active").length
              : id === "tiktok" ? tiktokAccounts.filter((a) => a.status === "active").length
              : id === "facebook" ? metaAccounts.filter((a) => a.status === "active").length
              // IG 는 비즈니스 로그인으로 직접 붙는다 — Meta 행의 잔존 ig* 는 세지 않는다
              // (그 토큰으로는 더 이상 IG 게시가 안 된다). 토큰 만료 계정도 뺀다.
              : id === "instagram" ? igAccounts.filter((a) =>
                  a.status === "active" && !(a.expiresAt && Number(a.expiresAt) < Date.now())).length
              // 네이버는 계정마다 쓸 곳(target)이 정해져 있다. TV 전용 계정을 클립 카드에서
              // 세면 "연결됨"인데 발행이 거부되는 모순이 생긴다.
              : id === "naverclip" ? naverAccounts.filter((a) => a.target !== "tv" && a.hasSession).length
              : 0;
            // 목록을 못 읽었으면 "0개 연결"이 아니라 "확인 불가"다 — 아래 섹션은 실패를
            // 말하는데 상단 카드만 0을 단정하면 화면 안에서 자기모순이 난다.
            const countUnknown =
              id === "youtube" ? loadFailed.youtube
              : id === "facebook" ? loadFailed.meta
              : id === "instagram" ? loadFailed.ig
              : id === "tiktok" ? loadFailed.tiktok
              : false;
            // 네이버는 OAuth 가 아니라 로그인 세션이라 아래 전용 섹션에서 다룬다.
            const isNaver = id === "naverclip";
            const connectHref =
              id === "facebook" ? getMetaAuthUrl("/publish-channels")
              : id === "instagram" ? getInstagramAuthUrl("/publish-channels")
              : id === "tiktok" ? getTikTokAuthUrl("/publish-channels")
              : null;
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
                      {/* 연결 여부가 먼저다 — 실제로 연결된 계정이 있는데 '준비 중'이라고 하면 거짓말이다. */}
                      {countUnknown ? (
                        <StatusBadge tone="warn">확인 불가</StatusBadge>
                      ) : connectedCount > 0 ? (
                        <StatusBadge tone="done">{connectedCount}개 연결</StatusBadge>
                      ) : isYouTube || connectHref || isNaver ? (
                        <StatusBadge tone="idle">미연결</StatusBadge>
                      ) : (
                        <StatusBadge tone="warn">연결 절차 없음</StatusBadge>
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
                ) : isNaver ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      document.getElementById("naver-accounts")?.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    네이버 계정 관리
                  </Button>
                ) : connectHref ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      window.location.href = connectHref;
                    }}
                  >
                    {connectedCount > 0 ? "계정 추가·새로고침" : "+ 계정 연결"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled
                    className="w-full"
                    // 지금은 여기 오는 채널이 없다. DISTRIBUTION_CHANNELS 에 연결 경로가
                    // 아직 없는 채널을 추가했을 때를 위한 폴백이다.
                    title="이 채널은 아직 연결 절차가 없습니다."
                  >
                    연결 절차 없음
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      </section>

      <NaverAccounts onChange={setNaverAccounts} />

      {/* Facebook: Meta OAuth — Page 단위. IG 는 아래 전용 섹션(비즈니스 로그인)으로 분리됨. */}
      <section className="mb-10">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">페이스북 연결</h2>
          <span className="text-[11px] text-muted-foreground/70">
            (Facebook Page 소유자로 로그인 — 관리하는 모든 Page 가 저장됨)
          </span>
        </div>

        <Card className="p-4 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              Facebook Page 를 Meta OAuth 로 등록합니다.
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

        {loading ? (
          <div className="text-sm text-muted-foreground">불러오는 중...</div>
        ) : loadFailed.meta ? (
          <Card className="p-6">
            <div className="text-sm text-status-warn">
              Facebook Page 목록을 불러오지 못했습니다 — 서버 연결을 확인한 뒤 새로고침하세요.
            </div>
          </Card>
        ) : metaAccounts.length === 0 ? (
          <Card className="p-6">
            <div className="text-sm text-muted-foreground">
              연결된 Facebook Page 가 없습니다. 위 "+ Meta 계정 연결" 을 누르면
              관리하는 모든 Facebook Page 가 저장됩니다.
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
                        {/* ig* 는 분리 전 통합 연결의 잔재 — 재연결하면 지워진다. IG 는 아래 전용 섹션. */}
                        {a.igUsername ? ` · (구) IG @${a.igUsername}` : ""}
                        {a.connectedAt &&
                          ` · ${new Date(Number(a.connectedAt)).toLocaleDateString("ko-KR")} 연결`}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={a.status === "active" ? "done" : "warn"}>
                      {a.status === "active" ? "활성"
                        : a.status === "disconnected" ? "연동 끊김 — 재연결 필요" : a.status}
                    </StatusBadge>
                    <RuleControls
                      platform="facebook"
                      accountId={a.pageId}
                      accountLabel={a.pageName}
                      ruled={ruledKeys.has(`facebook:${a.pageId}`)}
                      unknown={rulesErr !== null}
                      onOpen={setRuleFor}
                      prefix="FB "
                    />
                    {a.igUserId && (
                      <RuleControls
                        platform="instagram"
                        accountId={a.igUserId}
                        accountLabel={a.igUsername ? `@${a.igUsername}` : a.pageName}
                        ruled={ruledKeys.has(`instagram:${a.igUserId}`)}
                        unknown={rulesErr !== null}
                        onOpen={setRuleFor}
                        prefix="IG "
                      />
                    )}
                    {a.status === "active" && (
                      <button
                        onClick={() => handleDisconnectMeta(a.publicId)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:text-status-warn"
                      >
                        연동해제
                      </button>
                    )}
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

      {/* Instagram: 비즈니스 로그인 (IG 계정으로 직접 — Facebook Page 경유 아님) */}
      <section className="mb-10">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">인스타그램 연결 계정</h2>
          <span className="text-[11px] text-muted-foreground/70">
            (IG 프로페셔널 계정으로 직접 로그인 · 토큰 ~60일 — 만료 전 재연결 필요)
          </span>
        </div>

        <Card className="p-4 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              Instagram 비즈니스 로그인으로 계정을 연결합니다. Facebook Page 에 연결돼
              있지 않아도 됩니다 — 프로페셔널(비즈니스·크리에이터) 계정이면 됩니다.
            </div>
            <Button
              size="sm"
              onClick={() => {
                window.location.href = getInstagramAuthUrl("/publish-channels");
              }}
            >
              + Instagram 계정 연결
            </Button>
          </div>
        </Card>

        {loading ? (
          <div className="text-sm text-muted-foreground">불러오는 중...</div>
        ) : loadFailed.ig ? (
          <Card className="p-6">
            <div className="text-sm text-status-warn">
              Instagram 계정 목록을 불러오지 못했습니다 — 서버 연결을 확인한 뒤 새로고침하세요.
            </div>
          </Card>
        ) : igAccounts.length === 0 ? (
          <Card className="p-6">
            <div className="text-sm text-muted-foreground">
              연결된 Instagram 계정이 없습니다. 위 "+ Instagram 계정 연결" 버튼으로 붙이세요.
            </div>
          </Card>
        ) : (
          <div className="grid gap-3">
            {igAccounts.map((a) => {
              const expired = a.expiresAt && Number(a.expiresAt) < Date.now();
              // 만료된 뒤에야 알리면 이미 배포가 끊긴 뒤다 — 60일 토큰이라 임박(7일)에 미리 권한다.
              const expiringSoon = Boolean(a.expiresAt) && !expired
                && Number(a.expiresAt) - Date.now() < 7 * 24 * 60 * 60 * 1000;
              return (
                <Card key={a.publicId} className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {a.profilePictureUrl ? (
                        <img src={a.profilePictureUrl} alt={a.username} className="size-10 rounded-full" />
                      ) : (
                        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                          {a.username.charAt(0)}
                        </div>
                      )}
                      <div>
                        <div className="text-sm font-medium text-foreground">@{a.username}</div>
                        <div className="text-xs text-muted-foreground">
                          {a.name ? `${a.name} · ` : ""}
                          IG ID {a.igUserId}
                          {a.connectedAt &&
                            ` · ${new Date(Number(a.connectedAt)).toLocaleDateString("ko-KR")} 연결`}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone={a.status === "active" && !expired ? "done" : "warn"}>
                        {a.status !== "active" ? "연동 끊김 — 재연결 필요"
                          : expired ? "토큰 만료 — 재연결 필요" : "활성"}
                      </StatusBadge>
                      {a.status === "active" && expiringSoon && (
                        <StatusBadge tone="warn">토큰 만료 임박 — 재연결 권장</StatusBadge>
                      )}
                      <RuleControls
                        platform="instagram"
                        accountId={a.igUserId}
                        accountLabel={`@${a.username}`}
                        ruled={ruledKeys.has(`instagram:${a.igUserId}`)}
                        unknown={rulesErr !== null}
                        onOpen={setRuleFor}
                      />
                      {a.status === "active" && (
                        <button
                          onClick={() => handleDisconnectIg(a.publicId)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:text-status-warn"
                        >
                          연동해제
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteIg(a.publicId)}
                        className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-status-error"
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* TikTok: Login Kit — 게시(Content Posting) 권한은 앱 심사 승인 후에나 요청 가능 */}
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
              TikTok Login Kit 로 계정을 연결합니다. 지금은 기본 프로필 권한(user.info.basic)만
              요청됩니다 — 게시(Content Posting) 권한은 앱 심사 승인 후에 추가됩니다.
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

        {loading ? (
          <div className="text-sm text-muted-foreground">불러오는 중...</div>
        ) : loadFailed.tiktok ? (
          <Card className="p-6">
            <div className="text-sm text-status-warn">
              TikTok 계정 목록을 불러오지 못했습니다 — 서버 연결을 확인한 뒤 새로고침하세요.
            </div>
          </Card>
        ) : tiktokAccounts.length === 0 ? (
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
                      {/* 제목은 채널 핸들 우선 — display_name 은 실명(프로필 이름)이라 어느
                          채널인지 구분이 안 된다. 핸들이 없으면(구 연결·profile scope 이전)
                          실명으로 폴백하고, 재연동하면 핸들이 채워진다. */}
                      <div className="text-sm font-medium text-foreground">
                        {a.username ? `@${a.username}` : a.displayName}
                      </div>
                      <div className="text-xs text-muted-foreground" title={a.openId}>
                        {a.username ? `${a.displayName} · ` : ""}
                        open_id {a.openId.slice(0, 8)}…
                        {a.connectedAt &&
                          ` · ${new Date(Number(a.connectedAt)).toLocaleDateString("ko-KR")} 연결`}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={a.status === "active" ? "done" : "warn"}>
                      {a.status === "active" ? "활성"
                        : a.status === "disconnected" ? "연동 끊김 — 재연결 필요" : a.status}
                    </StatusBadge>
                    <RuleControls
                      platform="tiktok"
                      accountId={a.openId}
                      accountLabel={a.username ? `@${a.username}` : (a.displayName || a.openId)}
                      ruled={ruledKeys.has(`tiktok:${a.openId}`)}
                      unknown={rulesErr !== null}
                      onOpen={setRuleFor}
                    />
                    {a.status === "active" && (
                      <button
                        onClick={() => handleDisconnectTiktok(a.publicId)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:text-status-warn"
                      >
                        연동해제
                      </button>
                    )}
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
        ) : loadFailed.youtube ? (
          <Card className="p-6">
            <div className="text-sm text-status-warn">
              YouTube 채널 목록을 불러오지 못했습니다 — 서버 연결을 확인한 뒤 새로고침하세요.
            </div>
          </Card>
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
                      tone={ch.status === "active" ? "done"
                        : ch.status === "revoked" || ch.status === "disconnected" ? "warn" : "error"}
                    >
                      {ch.status === "active" ? "활성"
                        : ch.status === "revoked" ? "재연결 필요"
                        : ch.status === "disconnected" ? "연동 끊김 — 재연결 필요" : "오류"}
                    </StatusBadge>
                    <RuleControls
                      platform="youtube"
                      accountId={ch.channelId}
                      accountLabel={ch.channelName}
                      ruled={ruledKeys.has(`youtube:${ch.channelId}`)}
                      unknown={rulesErr !== null}
                      onOpen={setRuleFor}
                    />
                    {ch.status === "active" && (
                      <button
                        onClick={() => handleDisconnect(ch.channelId)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:text-status-warn"
                      >
                        연동해제
                      </button>
                    )}
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
          platform={ruleFor.platform}
          accountId={ruleFor.id}
          accountLabel={ruleFor.name}
          onClose={() => setRuleFor(null)}
          onSaved={loadRules}
        />
      )}
    </div>
  );
}
