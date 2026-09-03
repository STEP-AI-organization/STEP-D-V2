"use client";

/**
 * 상품 링크 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/commerce/page.tsx` 146줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * ## 🚨 최우선 안전 항목 — 제휴 링크는 **열지 않는다. 복사만 한다.**
 * `link.url` 은 쿠팡파트너스 제휴 단축 URL 이고, **자기 클릭은 계정 즉시 정지 사유**다.
 * 원본이 정확히 그 함정을 파 뒀다 — `ProductItem.url` 필드가 있고 `검토` 버튼에
 * `ExternalLink` 아이콘이 붙어 있어서, 가장 자연스러운 이식이 `<a href={prod.url}>` 이다.
 * **그게 금지된 동작이다.** 제휴 URL 은 복사 버튼으로만 나가고, 열람은 제휴가 아닌
 * `productUrl` 로만 한다.
 *
 * ## 원본은 사실상 "빈 상태 삽화" 다
 * `products` 가 빈 배열 상수고 유일한 버튼(`검토`)에 핸들러가 없다. 승인·거절·교체·발급
 * 버튼은 **존재하지도 않는다.** 이 화면의 목적물이 통째로 결번이라 전부 되살렸다.
 *
 * | 원본 | 이식본 |
 * |---|---|
 * | `products` 빈 상수 | `fetchCommerceReview()` |
 * | 계정 `하경진` 하드코딩(개인정보) | 실제 등록 계정 label |
 * | `status === '승인'` 한국어 리터럴 비교 | `approved/rejected/pending` — 원본대로면 **전부 "대기"** 로 나간다 |
 * | `prod.program` 표시 문자열 | 회차→프로그램 **id 조인** |
 * | `검토` 버튼 핸들러 없음 | 행 펼침 상세(승인·거절·교체·복사·미리보기) |
 *
 * ## 원본에 없어서 반드시 되살린 것
 *  1. **게이트 배너 4종** — 가장 조용한 사고다. 게이트 OFF·계정 미등록·세션 만료·세션키 없음.
 *     없으면 "화면은 정상인데 승인해도 영영 안 나가는" 상태를 아무도 모른다.
 *  2. **실제 발행 설명란 미리보기** — 서버가 조립한 진짜 발행문이다. 이게 유일한 가시화 수단이라
 *     ⓐ 클립당 링크 **3개 상한**(4개째 승인은 조용히 안 나간다) ⓑ **대가성 고지 문구**가
 *     안 보이게 된다. 화면이 직접 조립하지 않는다 — 서버가 정본이다.
 *  3. **승인/거절/되돌리기 3-상태** — 거절은 삭제가 아니라 상태라서 되돌릴 수 있다.
 *  4. **대체 후보 교체** — 없으면 파이프라인이 엉뚱한 상품을 고를 때 거절밖에 못 한다.
 *  5. **발급 버튼 + `accountReady` 게이트** · **장면 근거·검색어**(검토 판단의 유일한 근거).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, RotateCw, ShoppingBag, Undo2, X } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { useToast } from "@/components/ui/toast";
import {
  fetchClipCommerce,
  fetchCommerceAccount,
  fetchCommerceReview,
  issueCommerceLinks,
  saveCommerceDecisions,
  type ClipCommerce,
  type CommerceAccount,
  type CommerceLink,
  type CommerceLinkStatus,
  type CommerceReview,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";

const won = (n?: number) => (typeof n === "number" && n > 0 ? `${n.toLocaleString("ko-KR")}원` : "");

export default function CommercePage() {
  const { toast } = useToast();
  const { episodes, programs } = useAppData();
  const [review, setReview] = useState<CommerceReview | null>(null);
  const [acct, setAcct] = useState<{ account: CommerceAccount | null; sessionKeyReady: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClipCommerce | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [r, a] = await Promise.all([fetchCommerceReview(), fetchCommerceAccount()]);
      setReview(r);
      setAcct(a);
    } catch (e) {
      toast({ title: "검토 목록을 불러오지 못했습니다", description: (e as Error).message, tone: "error" });
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (clipId: string) => {
    setOpenId(clipId);
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await fetchClipCommerce(clipId));
    } catch (e) {
      toast({ title: "불러오지 못했습니다", description: (e as Error).message, tone: "error" });
    } finally {
      setDetailLoading(false);
    }
  }, [toast]);

  /** 승인·거절 — 저장 즉시 서버가 준 미리보기로 갈아끼운다(화면이 조립하지 않는다). */
  const decide = useCallback(async (link: CommerceLink, status: CommerceLinkStatus) => {
    if (!openId) return;
    setBusy(true);
    try {
      const out = await saveCommerceDecisions(openId, [{ url: link.url, status }]);
      setDetail((d) => (d ? { ...d, links: out.links, preview: out.preview } : d));
      await load();
    } catch (e) {
      toast({ title: "저장 실패", description: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [openId, load, toast]);

  /** 아직 링크가 없는 클립의 발급을 건다 — 계정 등록 전에 저장만 돼 있던 쿼리를 처리한다. */
  const issue = useCallback(async () => {
    if (!openId) return;
    setBusy(true);
    try {
      await issueCommerceLinks(openId);
      toast({ title: "발급 요청됨", description: "잠시 뒤 새로고침하면 반영됩니다." });
    } catch (e) {
      toast({ title: "발급 실패", description: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [openId, toast]);

  /** 다른 후보로 교체 — 발급은 브라우저 워커가 하므로 비동기다. */
  const swap = useCallback(async (query: string, productId: number) => {
    if (!openId) return;
    setBusy(true);
    try {
      await issueCommerceLinks(openId, { query, productId });
      toast({ title: "교체 요청됨", description: "링크를 새로 발급하는 중입니다. 잠시 뒤 새로고침하면 반영됩니다." });
    } catch (e) {
      toast({ title: "교체 실패", description: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [openId, toast]);

  /** ⚠️ 제휴 링크는 **열지 않는다**(자기 클릭 = 계정 정지). 복사만. */
  const copy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "링크를 복사했습니다" });
    } catch {
      toast({ title: "복사하지 못했습니다", tone: "error" });
    }
  }, [toast]);

  const rows = review?.clips ?? [];
  const pendingTotal = useMemo(() => rows.reduce((n, r) => n + r.pending, 0), [rows]);

  return (
    <>
      <Header title="상품 링크" subtitle="영상에서 찾은 상품 검토 — 승인한 것만 발행 설명란에 붙는다" />

      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-6">
        <div className="space-y-4 flex-1 flex flex-col min-h-0">
          {/* 게이트 배너 4종 — 원본엔 자리가 없다. 없으면 "승인해도 안 나가는" 걸 아무도 모른다. */}
          {review && !review.enabled && (
            <GateBanner tone="warn">
              커머스 링크 기능이 <strong>꺼져 있습니다</strong>. 여기서 승인해도 실제 발행 설명란에는
              반영되지 않습니다 (서버 <code>COMMERCE_LINKS_ENABLED</code>).
            </GateBanner>
          )}
          {acct && !acct.account && (
            <GateBanner tone="warn">
              <div className="font-semibold">쿠팡파트너스 계정이 등록되지 않았습니다</div>
              <div className="mt-1">
                커미션은 <strong>등록된 계정으로 정산</strong>되므로, 회사 법인 명의 계정을 한 번
                연결해야 링크가 발급됩니다. 워커 PC 에서{" "}
                <code className="rounded bg-[var(--color-bg-input)] px-1">pnpm --filter @stepd/server commerce:login</code>{" "}
                을 실행해 로그인하세요.
              </div>
            </GateBanner>
          )}
          {acct?.account?.status === "session_expired" && (
            <GateBanner tone="warn">
              <strong>{acct.account.label}</strong> 계정의 로그인이 만료됐습니다 — 다시 로그인해야
              새 링크가 발급됩니다 (<code className="rounded bg-[var(--color-bg-input)] px-1">commerce:login</code>).
              이미 승인된 링크는 그대로 발행됩니다.
            </GateBanner>
          )}
          {acct && !acct.sessionKeyReady && (
            <GateBanner tone="danger">
              서버에 <code>COMMERCE_SESSION_KEY</code> 가 없어 계정 세션을 저장할 수 없습니다
              (평문 저장은 하지 않습니다).
            </GateBanner>
          )}

          {/* Sub-header row: Info counter + Refresh button */}
          <div className="flex items-center justify-between text-xs select-none">
            <div className="text-[var(--color-text-muted)] font-medium flex items-center gap-1.5">
              <span>상품이 붙은 클립</span>
              <strong className="font-bold text-[var(--color-text-primary)]">{rows.length}개</strong>
              <span>·</span>
              <span>검토 대기</span>
              <strong className="font-bold text-[var(--color-text-primary)]">{pendingTotal}건</strong>
              <span>·</span>
              <span>계정</span>
              {/* 원본은 실명이 박혀 있었다(개인정보). 실제 등록 계정을 읽는다. */}
              <strong className="font-bold text-[var(--color-text-primary)]">
                {acct?.account?.label ?? "미등록"}
              </strong>
            </div>

            <button
              type="button"
              onClick={() => { void load(); }}
              className="px-4 py-2 rounded-full bg-[var(--color-bg-card)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-bold cursor-pointer transition-all flex items-center gap-1.5 shadow-md shadow-slate-900/5 dark:shadow-none"
            >
              <RotateCw className={`w-3.5 h-3.5 text-[var(--color-text-muted)] ${isRefreshing ? "animate-spin" : ""}`} />
              <span>새로고침</span>
            </button>
          </div>

          {/* Main Content Area: Empty State or Table List */}
          {rows.length === 0 ? (
            <div className="bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] rounded-2xl p-16 flex-1 flex flex-col items-center justify-center text-center shadow-md shadow-slate-900/5 dark:shadow-none min-h-[380px]">
              <div className="w-12 h-12 rounded-2xl bg-[var(--color-bg-input)] border-none flex items-center justify-center text-[var(--color-text-muted)] mb-4">
                <ShoppingBag className="w-6 h-6 stroke-[1.5]" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-bold text-[var(--color-text-primary)]">
                  {loading ? "불러오는 중…" : "검토할 상품이 없습니다"}
                </h3>
                <p className="text-xs text-[var(--color-text-muted)] leading-relaxed whitespace-nowrap">
                  영상 분석이 상품을 찾으면 여기에 쌓이고, 승인한 것만 발행 설명란에 붙습니다.
                </p>
              </div>
            </div>
          ) : (
            <div className="bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] rounded-2xl overflow-hidden flex flex-col flex-1 min-h-0 shadow-md shadow-slate-900/5 dark:shadow-none">
              <div className="flex items-center justify-between px-5 py-3 bg-[var(--color-bg-input)]/70 border-b border-[var(--color-border-subtle)] text-xs font-semibold text-[var(--color-text-muted)] select-none shrink-0">
                <span className="flex-1 text-left">상품 정보</span>
                <span className="w-32 text-left">프로그램 / 회차</span>
                <span className="w-24 text-center">상태</span>
                <span className="w-24 text-center">작업</span>
              </div>

              <div className="divide-y divide-[var(--color-border-subtle)]/40 overflow-y-auto flex-1">
                {rows.map((row) => {
                  const ep = episodes.find((e) => e.id === row.episodeId);
                  // 원본은 표시 문자열을 그대로 썼다 — 우리는 id 조인이다.
                  const prog = programs.find((p) => p.id === ep?.programId)?.title ?? row.programTitle ?? "—";
                  const isOpen = openId === row.clipId;
                  const status = row.pending > 0 ? "대기" : row.approved > 0 ? "승인" : "제외";
                  return (
                    <React.Fragment key={row.clipId}>
                      <div className="flex items-center justify-between px-5 py-3.5 hover:bg-[var(--color-bg-card-hover)] transition-colors text-xs">
                        <div className="flex items-center gap-3 flex-1 min-w-0 text-left">
                          <div className="w-12 h-12 rounded-xl bg-slate-900 overflow-hidden shrink-0 border border-[var(--color-border-subtle)]">
                            {row.thumbUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element -- 내부 미디어 프레임
                              <img src={row.thumbUrl} alt={row.clipTitle} loading="lazy" className="w-full h-full object-cover" />
                            ) : null}
                          </div>
                          <div className="min-w-0 space-y-0.5">
                            <h4 className="font-bold text-[var(--color-text-primary)] text-xs truncate" title={row.clipTitle}>
                              {row.clipTitle}
                            </h4>
                            <div className="text-[11px] font-semibold text-[var(--color-text-accent)]">
                              링크 {row.links.length} · 대기 {row.pending} · 붙음 {row.approved}
                            </div>
                          </div>
                        </div>

                        <div className="w-32 text-left text-xs text-[var(--color-text-muted)] font-medium truncate">
                          {prog} · {ep?.episodeNumber != null ? `회차 ${ep.episodeNumber}` : "—"}
                        </div>

                        <div className="w-24 flex justify-center text-center">
                          {/* 원본은 한국어 리터럴('승인')로 비교해서, 실데이터에선 전부 "대기" 로 나갔다. */}
                          <span
                            className={`inline-flex items-center justify-center px-3 py-1 rounded-full text-xs font-bold ${
                              status === "승인"
                                ? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400"
                                : "bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400"
                            }`}
                          >
                            {status}
                          </span>
                        </div>

                        <div className="w-24 flex justify-center text-center">
                          <button
                            onClick={() => { if (isOpen) setOpenId(null); else void openDetail(row.clipId); }}
                            className="px-3.5 py-1.5 rounded-full bg-[var(--color-bg-input)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-card-hover)] text-xs font-semibold border border-[var(--color-border-subtle)] transition-colors cursor-pointer flex items-center gap-1"
                          >
                            <span>검토</span>
                            <ExternalLink className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {/* 펼침 상세 — 원본엔 없다. 이 화면의 목적물이 전부 여기 있다. */}
                      {isOpen && (
                        <div className="px-5 py-4 bg-[var(--color-bg-input)]/40 space-y-4 text-xs">
                          {detailLoading || !detail ? (
                            <div className="text-[var(--color-text-muted)]">불러오는 중…</div>
                          ) : (
                            <>
                              {/* 링크가 아직 없다 — 무엇을 찾았는지와 왜 안 붙었는지를 말해준다. */}
                              {detail.links.length === 0 && detail.queries.length > 0 && (
                                <div className="space-y-2">
                                  <div className="text-[var(--color-text-muted)]">
                                    상품 {detail.queries.length}건을 찾았지만 아직 링크가 발급되지 않았습니다.
                                  </div>
                                  <ul className="space-y-1">
                                    {detail.queries.map((q) => (
                                      <li key={q.query} className="text-[11px] text-[var(--color-text-secondary)]">
                                        <strong>{q.query}</strong>
                                        {q.reason && <span className="text-[var(--color-text-muted)]"> — {q.reason}</span>}
                                      </li>
                                    ))}
                                  </ul>
                                  <button
                                    disabled={busy || !review?.accountReady}
                                    onClick={() => { void issue(); }}
                                    className="px-3.5 py-1.5 rounded-full bg-[var(--color-bg-input)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] text-xs font-semibold cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    링크 발급
                                  </button>
                                  {!review?.accountReady && (
                                    <div className="text-[11px] text-[var(--color-text-muted)]">
                                      계정이 등록돼야 발급할 수 있습니다.
                                    </div>
                                  )}
                                </div>
                              )}

                              {detail.links.map((link) => {
                                const cands = (detail.candidates[link.query] ?? []).filter((c) => c.productId !== link.productId);
                                return (
                                  <div key={link.url} className="rounded-xl bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] p-3">
                                    <div className="flex gap-3">
                                      {link.imageUrl && (
                                        // eslint-disable-next-line @next/next/no-img-element -- 상품 이미지
                                        <img src={link.imageUrl} alt="" className="w-16 h-16 shrink-0 rounded-lg border border-[var(--color-border-subtle)] object-cover" />
                                      )}
                                      <div className="min-w-0 flex-1 space-y-1">
                                        <div className="flex items-start gap-2">
                                          <div className="min-w-0 flex-1 font-bold text-[var(--color-text-primary)]">{link.productName}</div>
                                          <LinkStatusChip status={link.status} />
                                        </div>
                                        {/* 검토자가 판단할 근거 — 없으면 왜 붙었는지 알 수 없다. */}
                                        <div className="text-[11px] text-[var(--color-text-muted)]">
                                          {won(link.price)} · 검색어 &ldquo;{link.query}&rdquo;
                                        </div>
                                        {link.reason && (
                                          <div className="text-[11px] text-[var(--color-text-muted)]">장면: {link.reason}</div>
                                        )}

                                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                          {link.status === "approved" ? (
                                            <SmallBtn disabled={busy} onClick={() => void decide(link, "rejected")}>
                                              <Undo2 className="w-3 h-3" /> 빼기
                                            </SmallBtn>
                                          ) : (
                                            <SmallBtn primary disabled={busy} onClick={() => void decide(link, "approved")}>
                                              <Check className="w-3 h-3" /> 이걸로 붙이기
                                            </SmallBtn>
                                          )}
                                          {link.status !== "rejected" && link.status !== "approved" && (
                                            <SmallBtn disabled={busy} onClick={() => void decide(link, "rejected")}>
                                              <X className="w-3 h-3" /> 제외
                                            </SmallBtn>
                                          )}
                                          {/* 🚨 제휴 링크는 열지 않는다(자기 클릭 = 계정 정지). 복사만. */}
                                          <SmallBtn onClick={() => void copy(link.url)}>
                                            <Copy className="w-3 h-3" /> 링크 복사
                                          </SmallBtn>
                                          {/* 열람은 **제휴가 아닌** 상품 URL 로만. */}
                                          {link.productUrl && (
                                            <a
                                              href={link.productUrl}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                                            >
                                              <ExternalLink className="w-3 h-3" /> 상품 보기
                                            </a>
                                          )}
                                        </div>

                                        {cands.length > 0 && (
                                          <details className="pt-1">
                                            <summary className="cursor-pointer text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                                              다른 상품으로 바꾸기 ({cands.length})
                                            </summary>
                                            <div className="mt-2 space-y-1">
                                              {cands.map((c) => (
                                                <div key={c.productId} className="flex items-center gap-2 text-[11px]">
                                                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">{c.title}</span>
                                                  <span className="shrink-0 text-[var(--color-text-muted)]">{won(c.price)}</span>
                                                  <SmallBtn disabled={busy} onClick={() => void swap(link.query, c.productId!)}>
                                                    이걸로
                                                  </SmallBtn>
                                                </div>
                                              ))}
                                            </div>
                                          </details>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}

                              {/* 서버가 만든 발행문 그대로 — 승인분만 반영돼 있다.
                                  이게 클립당 3개 상한과 대가성 고지를 볼 수 있는 유일한 창이다. */}
                              <div>
                                <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-[var(--color-text-muted)]">
                                  실제 발행 설명란 (YouTube)
                                  {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                                </div>
                                <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                                  {detail.preview || "(설명 없음)"}
                                </pre>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <Footer />
      </main>
    </>
  );
}

/** 게이트 배너 — 원본에 없다. 카드와 같은 표면 언어로 그린다. */
function GateBanner({ tone, children }: { tone: "warn" | "danger"; children: React.ReactNode }) {
  const cls = tone === "danger"
    ? "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20"
    : "bg-amber-500/10 text-amber-800 dark:text-amber-400 border-amber-500/20";
  return <div className={`rounded-xl border px-4 py-3 text-xs leading-relaxed ${cls}`}>{children}</div>;
}

function LinkStatusChip({ status }: { status?: CommerceLinkStatus }) {
  const [label, cls] =
    status === "approved" ? ["붙음", "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"]
      : status === "rejected" ? ["제외", "bg-slate-500/15 text-[var(--color-text-muted)]"]
      : ["검토 대기", "bg-amber-500/15 text-amber-700 dark:text-amber-400"];
  return <span className={`shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-bold ${cls}`}>{label}</span>;
}

function SmallBtn({
  children, onClick, disabled, primary,
}: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
        primary
          ? "bg-[var(--color-bg-active)] text-white hover:bg-[#0D1EB8]"
          : "bg-[var(--color-bg-input)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-card-hover)]"
      }`}
    >
      {children}
    </button>
  );
}
