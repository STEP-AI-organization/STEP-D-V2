"use client";

/**
 * 상품 링크 검토 — **찾은 것과 붙는 것을 가르는 화면.**
 *
 * 파이프라인은 영상에서 상품을 찾아 제휴 링크까지 발급해 두지만, 그건 전부 "검토 대기"라
 * 어디에도 안 나간다. 여기서 사람이 승인한 것만 발행 설명란에 붙는다 — 자동화가 노동을 지고
 * 판단은 사람이 하는 경계다. 방송사 채널에 엉뚱한 상품이 걸리는 사고를 여기서 막는다.
 *
 * 설계 결정 셋:
 *  - **미리보기는 서버가 만든 것을 그대로 보여준다.** 화면이 따로 조립하면 실제 발행문과
 *    다른 말을 하게 된다 — 그러면 이 화면을 믿을 수 없다.
 *  - **제휴 링크는 열 수 없게 한다.** `<a>` 가 아니라 복사 버튼이다. 자기 클릭은 즉시
 *    계정 정지 사유라, 운영자가 무심코 눌러 확인하는 경로 자체를 만들지 않는다.
 *    상품이 뭔지 보려면 쿠팡 상품 페이지(제휴 아님)로 연다.
 *  - **거절도 되돌릴 수 있다.** 거절은 삭제가 아니라 상태다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, RefreshCw, ShoppingBag, Undo2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
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

const won = (n?: number) => (typeof n === "number" && n > 0 ? `${n.toLocaleString("ko-KR")}원` : "");

function StatusChip({ status }: { status?: CommerceLinkStatus }) {
  if (status === "approved") return <Badge className="bg-emerald-500/15 text-emerald-600">붙음</Badge>;
  if (status === "rejected") return <Badge className="bg-muted text-muted-foreground">제외</Badge>;
  return <Badge className="bg-amber-500/15 text-amber-600">검토 대기</Badge>;
}

export default function CommerceReviewPage() {
  const { toast } = useToast();
  const [review, setReview] = useState<CommerceReview | null>(null);
  const [acct, setAcct] = useState<{ account: CommerceAccount | null; sessionKeyReady: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClipCommerce | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([fetchCommerceReview(), fetchCommerceAccount()]);
      setReview(r);
      setAcct(a);
    } catch (e) {
      toast({ title: "검토 목록을 불러오지 못했습니다", description: (e as Error).message, tone: "error" });
    } finally {
      setLoading(false);
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
      toast({
        title: "교체 요청됨",
        description: "링크를 새로 발급하는 중입니다. 잠시 뒤 새로고침하면 반영됩니다.",
      });
    } catch (e) {
      toast({ title: "교체 실패", description: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [openId, toast]);

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

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 게이트가 꺼져 있으면 승인해도 안 나간다 — 화면이 먼저 말해야 한다. */}
      {review && !review.enabled && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          커머스 링크 기능이 <strong>꺼져 있습니다</strong>. 여기서 승인해도 실제 발행 설명란에는
          반영되지 않습니다 (서버 <code>COMMERCE_LINKS_ENABLED</code>).
        </Card>
      )}

      {/*
        회사마다 **자기 법인 파트너스 계정**을 쓴다 — 커미션 정산이 계정 단위이기 때문이다.
        계정이 없으면 서버가 아예 발급을 안 하는데(공용 계정으로 대신 발급하면 수익이 엉뚱한
        회사로 귀속된다), 그 사실을 화면이 말하지 않으면 "왜 아무것도 안 생기지" 로 막힌다.
      */}
      {acct && !acct.account && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <div className="font-semibold">쿠팡파트너스 계정이 등록되지 않았습니다</div>
          <div className="mt-1 text-muted-foreground">
            커미션은 <strong>등록된 계정으로 정산</strong>되므로, 회사 법인 명의 계정을 한 번
            연결해야 링크가 발급됩니다. 워커 PC 에서{" "}
            <code className="rounded bg-muted px-1">pnpm --filter @stepd/server commerce:login</code>{" "}
            을 실행해 로그인하세요.
          </div>
        </Card>
      )}
      {acct?.account?.status === "session_expired" && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <strong>{acct.account.label}</strong> 계정의 로그인이 만료됐습니다 — 다시 로그인해야
          새 링크가 발급됩니다 (<code className="rounded bg-muted px-1">commerce:login</code>).
          이미 승인된 링크는 그대로 발행됩니다.
        </Card>
      )}
      {acct && !acct.sessionKeyReady && (
        <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm">
          서버에 <code>COMMERCE_SESSION_KEY</code> 가 없어 계정 세션을 저장할 수 없습니다
          (평문 저장은 하지 않습니다).
        </Card>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          상품이 붙은 클립 <strong className="text-foreground">{rows.length}</strong>개 ·
          검토 대기 <strong className="text-foreground">{pendingTotal}</strong>건
          {acct?.account && <span> · 계정 <strong className="text-foreground">{acct.account.label}</strong></span>}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw /> 새로고침
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title="검토할 상품이 없습니다"
          description="영상 분석이 상품을 찾으면 여기에 쌓입니다. 승인한 것만 발행 설명란에 붙습니다."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Card key={row.clipId} className="overflow-hidden">
              <button
                type="button"
                onClick={() => (openId === row.clipId ? setOpenId(null) : void openDetail(row.clipId))}
                className="flex w-full items-center gap-3 p-3 text-left hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{row.clipTitle}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {row.programTitle ?? "프로그램 미지정"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-xs">
                  {/* 상품은 찾았는데 링크가 없다 = 발급이 아직 안 돌았다(계정 미등록·워커 미가동).
                      이걸 안 보여주면 "분석은 찾았는데 화면엔 아무것도 없는" 상태가 된다. */}
                  {row.links.length === 0 && row.queries > 0 && (
                    <Badge className="bg-sky-500/15 text-sky-600">발급 대기 {row.queries}</Badge>
                  )}
                  {row.pending > 0 && <Badge className="bg-amber-500/15 text-amber-600">대기 {row.pending}</Badge>}
                  {row.approved > 0 && <Badge className="bg-emerald-500/15 text-emerald-600">붙음 {row.approved}</Badge>}
                  {row.rejected > 0 && <Badge className="bg-muted text-muted-foreground">제외 {row.rejected}</Badge>}
                </div>
              </button>

              {openId === row.clipId && (
                <div className="border-t border-border bg-muted/20 p-3">
                  {detailLoading || !detail ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (
                    <div className="space-y-4">
                      {/* 링크가 아직 없다 — 무엇을 찾았는지와, 왜 안 붙었는지를 말해준다. */}
                      {detail.links.length === 0 && detail.queries.length > 0 && (
                        <div className="space-y-2 text-sm">
                          <div className="text-muted-foreground">
                            상품 {detail.queries.length}건을 찾았지만 아직 링크가 발급되지 않았습니다.
                          </div>
                          <ul className="space-y-1">
                            {detail.queries.map((q) => (
                              <li key={q.query} className="text-xs">
                                <strong>{q.query}</strong>
                                {q.reason && <span className="text-muted-foreground"> — {q.reason}</span>}
                              </li>
                            ))}
                          </ul>
                          <Button size="xs" variant="outline" disabled={busy || !review?.accountReady}
                            onClick={() => void issue()}>
                            <RefreshCw /> 링크 발급
                          </Button>
                          {!review?.accountReady && (
                            <div className="text-xs text-muted-foreground">
                              계정이 등록돼야 발급할 수 있습니다.
                            </div>
                          )}
                        </div>
                      )}
                      <div className="space-y-2">
                        {detail.links.map((link) => {
                          const cands = (detail.candidates[link.query] ?? [])
                            .filter((c) => c.productId !== link.productId);
                          return (
                            <Card key={link.url} className="p-3">
                              <div className="flex gap-3">
                                {link.imageUrl && (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={link.imageUrl}
                                    alt=""
                                    className="size-16 shrink-0 rounded-lg border border-border object-cover"
                                  />
                                )}
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex items-start gap-2">
                                    <div className="min-w-0 flex-1 text-sm font-medium">{link.productName}</div>
                                    <StatusChip status={link.status} />
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {won(link.price)} · 검색어 &ldquo;{link.query}&rdquo;
                                  </div>
                                  {link.reason && (
                                    <div className="text-xs text-muted-foreground">장면: {link.reason}</div>
                                  )}
                                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                    {link.status === "approved" ? (
                                      <Button size="xs" variant="outline" disabled={busy}
                                        onClick={() => void decide(link, "rejected")}>
                                        <Undo2 /> 빼기
                                      </Button>
                                    ) : (
                                      <Button size="xs" disabled={busy}
                                        onClick={() => void decide(link, "approved")}>
                                        <Check /> 이걸로 붙이기
                                      </Button>
                                    )}
                                    {link.status !== "rejected" && link.status !== "approved" && (
                                      <Button size="xs" variant="ghost" disabled={busy}
                                        onClick={() => void decide(link, "rejected")}>
                                        <X /> 제외
                                      </Button>
                                    )}
                                    {/* ⚠️ 제휴 링크는 열지 않는다(자기 클릭 = 계정 정지). 복사만. */}
                                    <Button size="xs" variant="ghost" onClick={() => void copy(link.url)}>
                                      <Copy /> 링크 복사
                                    </Button>
                                    {link.productUrl && (
                                      <a href={link.productUrl} target="_blank" rel="noreferrer"
                                        className="inline-flex h-7 items-center gap-1 rounded-[7px] px-2 text-xs text-muted-foreground hover:text-foreground">
                                        <ExternalLink className="size-3.5" /> 상품 보기
                                      </a>
                                    )}
                                  </div>

                                  {cands.length > 0 && (
                                    <details className="pt-1">
                                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                                        다른 상품으로 바꾸기 ({cands.length})
                                      </summary>
                                      <div className="mt-2 space-y-1">
                                        {cands.map((c) => (
                                          <div key={c.productId} className="flex items-center gap-2 text-xs">
                                            <span className="min-w-0 flex-1 truncate">{c.title}</span>
                                            <span className="shrink-0 text-muted-foreground">{won(c.price)}</span>
                                            <Button size="xs" variant="outline" disabled={busy}
                                              onClick={() => void swap(link.query, c.productId)}>
                                              이걸로
                                            </Button>
                                          </div>
                                        ))}
                                      </div>
                                    </details>
                                  )}
                                </div>
                              </div>
                            </Card>
                          );
                        })}
                      </div>

                      {/* 서버가 만든 발행문 그대로 — 승인분만 반영돼 있다. */}
                      <div>
                        <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                          실제 발행 설명란 (YouTube)
                          {busy && <Loader2 className="size-3 animate-spin" />}
                        </div>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-xs leading-relaxed">
                          {detail.preview || "(설명 없음)"}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
