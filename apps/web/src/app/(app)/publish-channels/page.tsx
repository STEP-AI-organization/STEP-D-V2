"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Info, Play } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { CustomSelect } from "@/components/ui/custom-select";
import type {
  YouTubeChannelInfo, MetaAccountInfo, InstagramAccountInfo, TikTokAccountInfo, NaverAccount,
  ChannelPublishTarget,
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
  saveChannelRule,
} from "@/lib/data/api";
import { NaverAccounts } from "@/components/publish/naver-accounts";
import { CoupangAccount } from "@/components/publish/coupang-account";
import { ChannelAnalysis } from "@/components/channel-analysis";
import {
  DISTRIBUTION_CHANNELS,
  type DistributionChannel,
  type DistributionChannelMeta,
} from "@/lib/constants";

/**
 * 배포 채널 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/publish-channels/page.tsx` 1,278줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 * 네이버·쿠팡 섹션은 원본이 이 파일에 인라인했지만 우리는 컴포넌트로 갈라 둔다 —
 * `naver-accounts.tsx`·`coupang-account.tsx` 는 **서버 테스트가 원문을 스캔**하므로
 * (`naver/login-tool?account=`·`commerce/login-tool`·`로그인 도우미 다운로드`) 경로를 유지한다.
 *
 * 각 플랫폼: YouTube·Facebook·Instagram·TikTok 은 OAuth 로 붙고, **네이버(TV·클립)는 OAuth 가
 * 없어** 로그인 세션을 등록하는 별도 섹션에서 다룬다. Instagram 은 2026-08-13 부터
 * Facebook(Meta OAuth)과 **분리** — IG 계정으로 직접 로그인하는 비즈니스 로그인을 쓴다.
 *
 * 새 채널 추가 흐름:
 *  1) lib/constants.ts DISTRIBUTION_CHANNELS 에 { label, icon, status } 항목 추가
 *  2) apps/web/public/channel-icons/<id>.png 배치 (공식 favicon 권장)
 *  3) 서버 /api/distributions/publish 스위치 + 필요 시 OAuth 라우트
 *
 * ⚠️ **연결됨 ≠ 파일이 올라간다.** 실제 업로드는 YouTube·네이버 클립·TikTok(게이트 ON 드래프트)이고,
 * Meta 는 배포 기록만 남는다(F4-3). 그래서 카드 안내 문구에서 그 사실을 분리해서 말한다.
 *
 * ## 원본이 목이라 되살린 것 — 이 화면은 **onClick 이 13개 빠져 있었다**
 *  - 연결·연동해제·삭제 버튼이 전부 `handleDisconnect('YouTube','채널')` 같은 **문자열 인자**를
 *    받는 목 함수로 간다. 어느 계정인지 모른다.
 *  - 연결 개수(`4개 연결`)·상태(`활성`)·연결일시가 전부 리터럴이다. 실제로는 disconnected·
 *    토큰 만료를 빼고 세야 "N개 연결인데 배포는 안 되는" 모순이 안 생긴다.
 *  - **목록 조회 실패와 "계정 없음"이 구분되지 않는다.** 서버가 죽으면 "0개 연결"로 둔갑한다.
 *  - 로고 4종이 외부 핫링크(depositphotos 워터마크·gstatic 캐시)다 → `/channel-icons/*.png`.
 *  - OAuth 콜백 배너(성공·실패·Page 0개)가 원본에 없다 → `<main>` 첫 자식으로 보존.
 */

/** 채널별 안내 문구 · 연결 방식. */
const CHANNEL_INFO: Record<DistributionChannel, { desc: string; note?: string }> = {
  youtube: {
    desc: "OAuth로 채널을 한 번에 연결 — 분석·수익과 배포 권한을 함께 요청합니다.",
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

/** 원본 리스트 카드 (D:586). */
const LIST_CARD = "bg-[var(--color-bg-card)] border-none rounded-2xl p-4 shadow-md shadow-slate-900/5 dark:shadow-none divide-y divide-[var(--color-border-subtle)]/60 text-xs";
/** 원본 4분할 행 (D:588·596). */
const ROW_GRID = "grid grid-cols-1 sm:grid-cols-[38%_16%_22%_24%] items-center gap-2 sm:gap-0";
/** 원본 보조 버튼 / 삭제 버튼 (D:626·633). */
const BTN = "px-3 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer shadow-none";
const BTN_DEL = "px-3 py-1.5 rounded-full bg-[var(--color-bg-card)] hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 dark:hover:bg-rose-950/60 dark:hover:text-rose-400 dark:hover:border-rose-900 text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer transition-colors shadow-none";
/** 원본 액션 배너 (D:568). */
const ACTION_CARD = "bg-[var(--color-bg-card)] border-none p-3.5 rounded-2xl flex items-center justify-between text-xs shadow-md shadow-slate-900/5 dark:shadow-none";
const BTN_PRIMARY = "px-3.5 py-2 rounded-full bg-[#222222] hover:bg-black text-white dark:bg-stone-700 dark:hover:bg-stone-600 text-xs font-bold cursor-pointer shadow-none border-none transition-colors";

/** 원본 상태 배지는 초록 '활성' 하나뿐이다(D:612). 톤만 갈랐다. */
function StatusPill({ label, tone }: { label: string; tone: "ok" | "warn" | "idle" }) {
  const cls =
    tone === "ok"
      ? "bg-[#ECFDF5] text-[#059669] dark:bg-emerald-500/20 dark:text-emerald-400"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400"
        : "bg-slate-200/80 text-slate-600 dark:bg-[#282B35] dark:text-slate-300";
  const dot =
    tone === "ok" ? "bg-[#059669] dark:bg-emerald-400"
      : tone === "warn" ? "bg-amber-500 dark:bg-amber-400"
        : "bg-slate-400 dark:bg-slate-500";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border-none ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      {label}
    </span>
  );
}

/** 원본은 연결일시가 `2026. 8. 26. 연결` 리터럴이다(D:619). */
function connectedLabel(at?: string | number | null): string {
  if (!at) return "—";
  const t = Number(at);
  if (!Number.isFinite(t)) return "—";
  return `${new Date(t).toLocaleDateString("ko-KR")} 연결`;
}

/** 섹션 헤더 — 원본 D:562. */
function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-base font-bold text-[var(--color-text-primary)]">
        {title} <span className="text-[11px] text-[var(--color-text-muted)] font-normal">({hint})</span>
      </h3>
    </div>
  );
}

/** 목록 자리의 로딩·실패·빈 상태. 원본엔 없다(항상 계정이 있다). */
function ListState({ text, warn }: { text: string; warn?: boolean }) {
  return (
    <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-6 shadow-md shadow-slate-900/5 dark:shadow-none text-xs text-center">
      <span className={warn ? "text-amber-600 dark:text-amber-400 font-medium" : "text-[var(--color-text-muted)]"}>
        {text}
      </span>
    </div>
  );
}

export default function PublishChannelsPage() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [metaAccounts, setMetaAccounts] = useState<MetaAccountInfo[]>([]);
  const [igAccounts, setIgAccounts] = useState<InstagramAccountInfo[]>([]);
  const [tiktokAccounts, setTiktokAccounts] = useState<TikTokAccountInfo[]>([]);
  const [channelRules, setChannelRules] = useState<Record<string, ChannelPublishTarget>>({});
  const [savingRule, setSavingRule] = useState<string | null>(null);
  // 네이버 계정은 아래 NaverAccounts 섹션이 소유한다. 여기서는 상단 카드의 숫자만 쓰려고
  // 사본을 받는다 — 두 곳에서 각자 fetch 하면 추가·삭제 후 숫자가 어긋난다.
  const [naverAccounts, setNaverAccounts] = useState<NaverAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ text: string; warn?: boolean } | null>(null);
  // .catch(() => []) 만 있으면 서버 다운이 "계정 없음"으로 둔갑한다 — 실패를 플랫폼별로
  // 기록해 빈 상태와 구분해서 그린다.
  const [loadFailed, setLoadFailed] = useState({ youtube: false, meta: false, ig: false, tiktok: false });
  // 원본은 드로어가 기본 전부 열림이다(D:17-24). 같은 기본값을 채널 목록에 적용한다.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const loadAll = async () => {
    const failed = { youtube: false, meta: false, ig: false, tiktok: false };
    try {
      const [chs, ma, ig, tt, rules] = await Promise.all([
        fetchYouTubeChannels().catch(() => { failed.youtube = true; return [] as YouTubeChannelInfo[]; }),
        fetchMetaAccounts().catch(() => { failed.meta = true; return [] as MetaAccountInfo[]; }),
        fetchInstagramAccounts().catch(() => { failed.ig = true; return [] as InstagramAccountInfo[]; }),
        fetchTikTokAccounts().catch(() => { failed.tiktok = true; return [] as TikTokAccountInfo[]; }),
        fetchChannelRules().catch(() => [] as ChannelPublishTarget[]),
      ]);
      setChannels(chs);
      setMetaAccounts(ma);
      setIgAccounts(ig);
      setTiktokAccounts(tt);
      setChannelRules(Object.fromEntries(rules.map((r) => [`${r.platform}:${r.accountId}`, r])));
      setLoadFailed(failed);
    } finally {
      setLoading(false);
    }
  };

  const handlePrivacyChange = async (channelId: string, privacy: ChannelPublishTarget["privacy"]) => {
    const key = `youtube:${channelId}`;
    const current = channelRules[key];
    setSavingRule(key);
    try {
      const rule = await saveChannelRule("youtube", channelId, {
        ...(current ?? { label: channels.find((c) => c.channelId === channelId)?.channelName ?? channelId }),
        privacy,
      });
      setChannelRules((prev) => ({ ...prev, [key]: rule }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "공개범위 저장에 실패했습니다.");
    } finally {
      setSavingRule(null);
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
  // ⚠️ 원본 목 함수는 `handleDelete('Facebook Page','계정')` 처럼 **문자열만** 받는다 —
  //    어느 계정인지 모르고, confirm 결과도 버린다. 실제 배선은 아래 8개다.
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
    <>
      <Header title="배포 채널" subtitle="YouTube·네이버·소셜 계정 연결 관리" />

      {/* Deploy Channels Main Content */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-6">
        <div className="space-y-6">
          {/* OAuth 콜백 배너 — 원본에 없다. 연결이 성공/실패한 직후 유일한 피드백이다. */}
          {banner && (
            <div
              className={`p-3.5 rounded-2xl text-xs font-medium shadow-md shadow-slate-900/5 dark:shadow-none ${
                banner.warn
                  ? "bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400"
                  : "bg-[var(--color-bg-card)] border-none text-[var(--color-text-primary)]"
              }`}
            >
              {banner.text}
            </div>
          )}

          {/* Top Overview Cards Section: 플랫폼 (5 Columns Grid on PC, Hover Tooltip below Button in Gray) */}
          <div>
            <h3 className="text-base font-bold text-[var(--color-text-primary)] mb-3">플랫폼</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5 text-xs">
              {ids.map((id) => {
                // 넓은 타입으로 받는다. 지금은 모든 채널에 아이콘이 있어서, 리터럴 타입 그대로
                // 두면 아래 아이콘 없음 폴백이 `never` 가 되어 컴파일이 깨진다.
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
                const onConnect = isNaver
                  ? () => document.getElementById("naver-accounts")?.scrollIntoView({ behavior: "smooth" })
                  : isYouTube
                    ? () => { window.location.href = getYouTubeAuthUrl(undefined, "all", "/publish-channels"); }
                    : connectHref
                      ? () => { window.location.href = connectHref; }
                      : undefined;

                return (
                  <div
                    key={id}
                    className="bg-[var(--color-bg-card)] border-none p-4 rounded-2xl flex flex-col items-center justify-between text-center space-y-3 shadow-md shadow-slate-900/5 dark:shadow-none"
                  >
                    <div className="flex flex-col items-center space-y-2.5 w-full">
                      {/* Top Center SNS Logo — 원본 4종은 외부 핫링크라 우리 공식 파비콘으로 바꿨다.
                          원형·크기·object-cover 는 그대로다. YouTube 만 원본이 자체 도형이라 유지. */}
                      {isYouTube ? (
                        <div className="w-11 h-11 rounded-full bg-red-600 flex items-center justify-center text-white text-sm font-bold border-none shadow-none">
                          <Play className="w-5 h-5 fill-current text-white ml-0.5" />
                        </div>
                      ) : (
                        <div className="w-11 h-11 rounded-full overflow-hidden bg-stone-900 border-none flex items-center justify-center shrink-0 shadow-none">
                          {meta.icon ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={meta.icon} alt={meta.label} draggable={false} className="w-full h-full object-cover rounded-full" />
                          ) : (
                            <span className="text-white text-sm font-bold">{meta.label.charAt(0)}</span>
                          )}
                        </div>
                      )}
                      {/* Platform Name */}
                      <span className="font-bold text-sm text-[var(--color-text-primary)]">{meta.label}</span>
                      {/* Connected Count Tag (No Dot) — 원본은 초록 "N개 연결" 고정이다. */}
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border-none ${
                          countUnknown
                            ? "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400"
                            : connectedCount > 0
                              ? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400"
                              : "bg-slate-200/80 text-slate-600 dark:bg-[#282B35] dark:text-slate-300"
                        }`}
                      >
                        {countUnknown ? "확인 불가" : connectedCount > 0 ? `${connectedCount}개 연결` : onConnect ? "미연결" : "연결 절차 없음"}
                      </span>
                    </div>

                    {/* Button Container with Hover Tooltip Popup Below */}
                    <div className="relative group/btn w-full mt-1">
                      <div className="absolute left-1/2 -translate-x-1/2 top-[calc(100%+10px)] z-30 w-60 p-3 bg-white dark:bg-stone-900 border border-slate-200 dark:border-stone-700 rounded-xl shadow-xl opacity-0 invisible group-hover/btn:opacity-100 group-hover/btn:visible transition-all duration-200 pointer-events-none text-left">
                        {/* Tooltip Speech Bubble Tail pointing UP */}
                        <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white dark:bg-stone-900 border-t border-l border-slate-200 dark:border-stone-700 rotate-45 z-10" />
                        <div className="flex items-start gap-2 relative z-20">
                          <Info className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                          <p className="text-xs text-slate-600 dark:text-stone-300 leading-relaxed font-normal">
                            {info.desc}{info.note ? ` ${info.note}` : ""}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={onConnect}
                        disabled={!onConnect}
                        // 지금은 여기 오는 채널이 없다. DISTRIBUTION_CHANNELS 에 연결 경로가
                        // 아직 없는 채널을 추가했을 때를 위한 폴백이다.
                        title={onConnect ? undefined : "이 채널은 아직 연결 절차가 없습니다."}
                        className="w-full py-2 px-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-bold transition-colors cursor-pointer shadow-none [box-shadow:none] disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isNaver ? "네이버 계정 관리" : onConnect ? "계정 추가·새로고침" : "연결 절차 없음"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* SECTION 1·2: 네이버 연동 · 쿠팡파트너스 (원본은 이 파일 인라인 · 우리는 컴포넌트) */}
          <NaverAccounts onChange={setNaverAccounts} />
          <CoupangAccount />

          {/* SECTION 3: 페이스북 연동 */}
          <div className="space-y-3">
            <SectionTitle title="페이스북 연동" hint="Facebook Page 소유자로 로그인 — 관리하는 모든 Page 가 저장됨" />

            {/* Action Notice Card */}
            <div className={ACTION_CARD}>
              <span className="text-xs text-[var(--color-text-muted)]">
                Facebook Page 를 Meta OAuth 로 등록합니다. 같은 Meta 계정을 다시 클릭하면 최신 Page 목록으로 새로고침됩니다.
              </span>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <button
                  type="button"
                  style={{ boxShadow: "none" }}
                  onClick={() => { window.location.href = getMetaAuthUrl("/publish-channels", true); }}
                  className="px-3.5 py-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] text-xs font-medium cursor-pointer shadow-none"
                >
                  권한 재요청
                </button>
                <button
                  type="button"
                  style={{ boxShadow: "none" }}
                  onClick={() => { window.location.href = getMetaAuthUrl("/publish-channels"); }}
                  className={BTN_PRIMARY}
                >
                  + Meta 계정 연결
                </button>
              </div>
            </div>

            {loading ? (
              <ListState text="불러오는 중…" />
            ) : loadFailed.meta ? (
              <ListState warn text="Facebook Page 목록을 불러오지 못했습니다 — 서버 연결을 확인한 뒤 새로고침하세요." />
            ) : metaAccounts.length === 0 ? (
              <ListState text="연결된 Facebook Page 가 없습니다. 위 &quot;+ Meta 계정 연결&quot; 을 누르면 관리하는 모든 Facebook Page 가 저장됩니다." />
            ) : (
              /* Clean Table List Container */
              <div className={LIST_CARD}>
                {/* List Header */}
                <div className={`hidden sm:grid grid-cols-[38%_16%_22%_24%] items-center text-[11px] font-bold text-[var(--color-text-muted)] pb-2.5 px-3`}>
                  <div className="text-left">페이지 정보</div>
                  <div className="text-center">상태</div>
                  <div className="text-center">연결일시</div>
                  <div className="text-right">관리</div>
                </div>

                {metaAccounts.map((a) => (
                  <div key={a.publicId} className={`${ROW_GRID} px-3 py-3`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 border-none bg-[var(--color-bg-input)] flex items-center justify-center">
                        {a.pageProfilePictureUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={a.pageProfilePictureUrl} alt={a.pageName} className="w-full h-full object-cover rounded-full" />
                        ) : (
                          <span className="text-[var(--color-text-muted)] text-xs font-bold">{a.pageName.charAt(0)}</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <h4 className="font-bold text-sm text-[var(--color-text-primary)] truncate">{a.pageName}</h4>
                        <p className="text-[11px] text-[var(--color-text-muted)] truncate">
                          FB Page ID {a.pageId}
                          {/* ig* 는 분리 전 통합 연결의 잔재 — 재연결하면 지워진다. IG 는 아래 전용 섹션. */}
                          {a.igUsername ? ` · (구) IG @${a.igUsername}` : ""}
                        </p>
                      </div>
                    </div>

                    <div className="hidden sm:flex items-center justify-center text-center">
                      <StatusPill
                        tone={a.status === "active" ? "ok" : "warn"}
                        label={a.status === "active" ? "활성" : a.status === "disconnected" ? "연동 끊김 — 재연결 필요" : a.status}
                      />
                    </div>

                    <div className="hidden sm:flex items-center justify-center text-center text-[11px] text-[var(--color-text-muted)] font-mono truncate">
                      {connectedLabel(a.connectedAt)}
                    </div>

                    <div className="flex items-center justify-end gap-1.5 shrink-0">
                      {a.status === "active" && (
                        <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDisconnectMeta(a.publicId)} className={BTN}>
                          연동해제
                        </button>
                      )}
                      <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDeleteMeta(a.publicId)} className={BTN_DEL}>
                        삭제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* SECTION 4: 인스타그램 연동 */}
          <div className="space-y-3">
            <SectionTitle title="인스타그램 연동" hint="IG 프로페셔널 계정으로 직접 로그인 · 토큰 ~60일 — 만료 전 재연결 필요" />

            <div className={ACTION_CARD}>
              <span className="text-xs text-[var(--color-text-muted)]">
                Instagram 비즈니스 로그인으로 계정을 연결합니다. Facebook Page 에 연결돼 있지 않아도 됩니다 — 프로페셔널(비즈니스·크리에이터) 계정이면 됩니다.
              </span>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <button
                  type="button"
                  style={{ boxShadow: "none" }}
                  onClick={() => { window.location.href = getInstagramAuthUrl("/publish-channels"); }}
                  className={BTN_PRIMARY}
                >
                  + Instagram 계정 연결
                </button>
              </div>
            </div>

            {loading ? (
              <ListState text="불러오는 중…" />
            ) : loadFailed.ig ? (
              <ListState warn text="Instagram 계정 목록을 불러오지 못했습니다 — 서버 연결을 확인한 뒤 새로고침하세요." />
            ) : igAccounts.length === 0 ? (
              <ListState text="연결된 Instagram 계정이 없습니다. 위 &quot;+ Instagram 계정 연결&quot; 버튼으로 붙이세요." />
            ) : (
              <div className={LIST_CARD}>
                <div className="hidden sm:grid grid-cols-[38%_16%_22%_24%] items-center text-[11px] font-bold text-[var(--color-text-muted)] pb-2.5 px-3">
                  <div className="text-left">계정 정보</div>
                  <div className="text-center">상태</div>
                  <div className="text-center">연결일시</div>
                  <div className="text-right">관리</div>
                </div>

                {igAccounts.map((a) => {
                  const expired = Boolean(a.expiresAt && Number(a.expiresAt) < Date.now());
                  // 만료된 뒤에야 알리면 이미 배포가 끊긴 뒤다 — 60일 토큰이라 임박(7일)에 미리 권한다.
                  const expiringSoon = Boolean(a.expiresAt) && !expired
                    && Number(a.expiresAt) - Date.now() < 7 * 24 * 60 * 60 * 1000;
                  return (
                    <div key={a.publicId} className={`${ROW_GRID} px-3 py-3`}>
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 border-none bg-[var(--color-bg-input)] flex items-center justify-center">
                          {a.profilePictureUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={a.profilePictureUrl} alt={a.username} className="w-full h-full object-cover rounded-full" />
                          ) : (
                            <span className="text-[var(--color-text-muted)] text-xs font-bold">{a.username.charAt(0)}</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <h4 className="font-bold text-sm text-[var(--color-text-primary)] truncate">@{a.username}</h4>
                          <p className="text-[11px] text-[var(--color-text-muted)] truncate">
                            {a.name ? `${a.name} · ` : ""}IG ID {a.igUserId}
                          </p>
                        </div>
                      </div>

                      <div className="hidden sm:flex items-center justify-center text-center">
                        <StatusPill
                          tone={a.status === "active" && !expired ? "ok" : "warn"}
                          label={
                            a.status !== "active" ? "연동 끊김 — 재연결 필요"
                              : expired ? "토큰 만료 — 재연결 필요"
                                : expiringSoon ? "만료 임박 — 재연결 권장" : "활성"
                          }
                        />
                      </div>

                      <div className="hidden sm:flex items-center justify-center text-center text-[11px] text-[var(--color-text-muted)] font-mono truncate">
                        {connectedLabel(a.connectedAt)}
                      </div>

                      <div className="flex items-center justify-end gap-1.5 shrink-0">
                        {a.status === "active" && (
                          <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDisconnectIg(a.publicId)} className={BTN}>
                            연동해제
                          </button>
                        )}
                        <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDeleteIg(a.publicId)} className={BTN_DEL}>
                          삭제
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* SECTION 5: TikTok 연동 */}
          <div className="space-y-3">
            <SectionTitle title="TikTok 연동" hint="access token ~24h · refresh token ~365d · 업로드 전 자동 갱신" />

            <div className={ACTION_CARD}>
              <span className="text-xs text-[var(--color-text-muted)]">
                TikTok Login Kit 로 계정을 연결합니다. 지금은 기본 프로필 권한(user.info.basic)만 요청됩니다 — 게시(Content Posting) 권한은 앱 심사 승인 후에 추가됩니다.
              </span>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <button
                  type="button"
                  style={{ boxShadow: "none" }}
                  onClick={() => { window.location.href = getTikTokAuthUrl("/publish-channels"); }}
                  className={BTN_PRIMARY}
                >
                  + TikTok 계정 연결
                </button>
              </div>
            </div>

            {loading ? (
              <ListState text="불러오는 중…" />
            ) : loadFailed.tiktok ? (
              <ListState warn text="TikTok 계정 목록을 불러오지 못했습니다 — 서버 연결을 확인한 뒤 새로고침하세요." />
            ) : tiktokAccounts.length === 0 ? (
              <ListState text="연결된 TikTok 계정이 없습니다. 위 &quot;+ TikTok 계정 연결&quot; 버튼으로 붙이세요." />
            ) : (
              <div className={LIST_CARD}>
                <div className="hidden sm:grid grid-cols-[38%_16%_22%_24%] items-center text-[11px] font-bold text-[var(--color-text-muted)] pb-2.5 px-3">
                  <div className="text-left">계정 정보</div>
                  <div className="text-center">상태</div>
                  <div className="text-center">연결일시</div>
                  <div className="text-right">관리</div>
                </div>

                {tiktokAccounts.map((a) => (
                  <div key={a.publicId} className={`${ROW_GRID} px-3 py-3`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 border-none bg-[var(--color-bg-input)] flex items-center justify-center">
                        {a.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={a.avatarUrl} alt={a.displayName} className="w-full h-full object-cover rounded-full" />
                        ) : (
                          <span className="text-[var(--color-text-muted)] text-xs font-bold">{a.displayName.charAt(0)}</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        {/* 제목은 채널 핸들 우선 — display_name 은 실명(프로필 이름)이라 어느
                            채널인지 구분이 안 된다. 핸들이 없으면(구 연결·profile scope 이전)
                            실명으로 폴백하고, 재연동하면 핸들이 채워진다. */}
                        <h4 className="font-bold text-sm text-[var(--color-text-primary)] truncate">
                          {a.username ? `@${a.username}` : a.displayName}
                        </h4>
                        <p className="text-[11px] text-[var(--color-text-muted)] truncate" title={a.openId}>
                          {a.username ? `${a.displayName} · ` : ""}open_id {a.openId.slice(0, 10)}...
                        </p>
                      </div>
                    </div>

                    <div className="hidden sm:flex items-center justify-center text-center">
                      <StatusPill
                        tone={a.status === "active" ? "ok" : "warn"}
                        label={a.status === "active" ? "활성" : a.status === "disconnected" ? "연동 끊김 — 재연결 필요" : a.status}
                      />
                    </div>

                    <div className="hidden sm:flex items-center justify-center text-center text-[11px] text-[var(--color-text-muted)] font-mono truncate">
                      {connectedLabel(a.connectedAt)}
                    </div>

                    <div className="flex items-center justify-end gap-1.5 shrink-0">
                      {a.status === "active" && (
                        <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDisconnectTiktok(a.publicId)} className={BTN}>
                          연동해제
                        </button>
                      )}
                      <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDeleteTiktok(a.publicId)} className={BTN_DEL}>
                        삭제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* SECTION 6: YouTube 채널 연동 */}
          <div className="space-y-3">
            <SectionTitle title="YouTube 채널 연동" hint="같은 채널을 분석·업로드 둘 다 쓰려면 각각 한 번씩 연결 — 토큰이 서로 덮어씀" />

            {loading ? (
              <ListState text="불러오는 중…" />
            ) : loadFailed.youtube ? (
              <ListState warn text="YouTube 채널 목록을 불러오지 못했습니다 — 서버 연결을 확인한 뒤 새로고침하세요." />
            ) : channels.length === 0 ? (
              <ListState text="연동된 YouTube 채널이 없습니다. 위 카드의 '계정 추가·새로고침' 으로 붙이세요. 외부 협력자는 /register 페이지에서 직접 등록할 수 있습니다." />
            ) : (
              /* Clean Table List Container */
              <div className={LIST_CARD}>
                {/* List Header */}
                <div className="hidden sm:grid grid-cols-[38%_16%_22%_24%] items-center text-[11px] font-bold text-[var(--color-text-muted)] pb-2.5 px-3">
                  <div className="text-left">채널 정보</div>
                  <div className="text-center">상태</div>
                  <div className="text-center">연결일시</div>
                  <div className="text-right">관리 / 공개범위 / 통계</div>
                </div>

                {channels.map((ch) => {
                  const open = !collapsed[ch.channelId]; // 원본은 기본 열림
                  const toggle = () => setCollapsed((p) => ({ ...p, [ch.channelId]: !p[ch.channelId] }));
                  const rule = channelRules[`youtube:${ch.channelId}`];
                  const privacy = rule?.privacy ?? "unlisted";
                  return (
                    <div key={ch.channelId} className="py-3.5 first:pt-2 last:pb-0">
                      <div
                        onClick={toggle}
                        className={`${ROW_GRID} px-3 cursor-pointer hover:bg-[var(--color-bg-input)]/40 rounded-xl py-1.5 transition-colors`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-red-600 text-white font-bold flex items-center justify-center text-xs shrink-0 overflow-hidden">
                            {ch.thumbnail ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={ch.thumbnail} alt={ch.channelName} className="w-full h-full object-cover" />
                            ) : (
                              ch.channelName.charAt(0)
                            )}
                          </div>
                          <div className="min-w-0">
                            <h4 className="font-bold text-sm text-[var(--color-text-primary)] truncate">{ch.channelName}</h4>
                            <p className="text-[11px] text-[var(--color-text-muted)] truncate">구독자 {ch.subscribers ?? "?"}명</p>
                          </div>
                        </div>

                        <div className="hidden sm:flex items-center justify-center text-center">
                          <StatusPill
                            tone={ch.status === "active" ? "ok" : "warn"}
                            label={
                              ch.status === "active" ? "활성"
                                : ch.status === "revoked" ? "재연결 필요"
                                  : ch.status === "disconnected" ? "연동 끊김 — 재연결 필요" : "오류"
                            }
                          />
                        </div>

                        <div className="hidden sm:flex items-center justify-center text-center text-[11px] text-[var(--color-text-muted)] font-mono truncate">
                          {connectedLabel(ch.connectedAt)}
                        </div>

                        <div className="flex items-center justify-end gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                          {ch.status === "active" && (
                            <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDisconnect(ch.channelId)} className={BTN}>
                              연동해제
                            </button>
                          )}
                          <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDelete(ch.channelId)} className={BTN_DEL}>
                            삭제
                          </button>
                          <button
                            type="button"
                            style={{ boxShadow: "none" }}
                            onClick={(e) => { e.stopPropagation(); toggle(); }}
                            title="공개범위 및 90일 통계 보기"
                            className="p-1.5 rounded-full hover:bg-[var(--color-bg-input)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer shadow-none"
                          >
                            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {/* Expandable Detail Sub-Drawer (Open by default) */}
                      {open && (
                        <div className="mt-3 p-3.5 rounded-xl bg-[var(--color-bg-input)]/50 border border-[var(--color-border-subtle)] animate-in fade-in duration-150 text-xs">
                          {/* 공개범위는 활성 채널에만 의미가 있다 — 끊긴 채널엔 자동배포가 안 간다. */}
                          {ch.status === "active" && (
                            <div className="flex items-center justify-between gap-4 pb-3.5">
                              <div>
                                <span className="font-bold text-xs text-[var(--color-text-primary)]">자동배포 공개범위</span>
                                <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                                  현재 {PRIVACY_LABEL[privacy]} · 자동배포 규칙이 이 설정을 사용합니다.
                                </p>
                              </div>
                              <div className="w-32 shrink-0">
                                <CustomSelect
                                  options={PRIVACY_OPTIONS}
                                  value={privacy}
                                  onChange={(v) => handlePrivacyChange(ch.channelId, v as ChannelPublishTarget["privacy"])}
                                  ariaLabel="자동배포 공개범위"
                                  triggerClassName={`bg-[var(--color-bg-card)] text-[var(--color-text-primary)] text-xs py-1.5 px-3${
                                    savingRule === `youtube:${ch.channelId}` ? " opacity-50 pointer-events-none" : ""
                                  }`}
                                  dropdownClassName="shadow-xl text-xs"
                                />
                              </div>
                            </div>
                          )}
                          <ChannelAnalysis channelId={ch.channelId} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

/**
 * 공개범위 — 서버 값은 `public|unlisted|private` 이다. 원본 라벨은 `['일부 공개','공개','비공개']`
 * 라 `public` 을 **"공개"** 라고 부른다. 자동배포 화면도 같은 값을 쓰므로 라벨은 한 곳에서.
 */
const PRIVACY_LABEL: Record<string, string> = {
  unlisted: "일부 공개",
  public: "공개",
  private: "비공개",
};
const PRIVACY_OPTIONS = [
  { value: "unlisted", label: "일부 공개" },
  { value: "public", label: "공개" },
  { value: "private", label: "비공개" },
];
