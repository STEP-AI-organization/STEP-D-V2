"use client";

import { useRef, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { CardCredentialInput } from "@/lib/data/api";

const INPUT = "mt-1 w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 민감한 입력은 DOM 안에서만 유지하고, 요청 종료·취소·닫기 때 지운다. */
export function CardRegistrationForm({ busy, buyerReady, replacing, onRegister, onCancel }: {
  busy: boolean;
  buyerReady: boolean;
  replacing: boolean;
  onRegister: (credential: CardCredentialInput) => Promise<void>;
  onCancel: () => void;
}) {
  const submitting = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy || !buyerReady) return;
    submitting.current = true;
    const form = event.currentTarget;
    const data = new FormData(form);
    const read = (key: string) => String(data.get(key) ?? "").trim();
    try {
      await onRegister({
        number: read("number"),
        expiryMonth: read("expiryMonth"),
        expiryYear: read("expiryYear"),
        ...(read("identity") ? { birthOrBusinessRegistrationNumber: read("identity") } : {}),
        ...(read("password") ? { passwordTwoDigits: read("password") } : {}),
      });
    } finally {
      form.reset();
      submitting.current = false;
    }
  }

  return (
    <form onSubmit={submit} autoComplete="off" data-private data-hj-suppress data-dd-privacy="mask">
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3 disabled:opacity-60">
        <legend className="mb-2 text-xs font-semibold text-foreground">
          {replacing ? "새 카드 정보" : "카드 정보"}
        </legend>
        <label className="text-xs text-foreground">
          카드번호
          <input name="number" inputMode="numeric" autoComplete="off" required
            maxLength={23} pattern="[0-9 -]{13,23}" placeholder="카드번호 입력" className={INPUT} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-foreground">
            유효기간 월
            <input name="expiryMonth" inputMode="numeric" required maxLength={2}
              pattern="0[1-9]|1[0-2]" placeholder="MM" className={INPUT} />
          </label>
          <label className="text-xs text-foreground">
            유효기간 연도
            <input name="expiryYear" inputMode="numeric" required maxLength={2}
              pattern="[0-9]{2}" placeholder="YY" className={INPUT} />
          </label>
        </div>
        <details className="rounded-xl border border-border p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer text-foreground">추가 카드 확인정보 (필요한 경우)</summary>
          <p className="mt-2 leading-relaxed">카드사에서 요구하는 경우 입력해 주세요. 법인카드는 사업자등록번호, 개인·개인명의 법인카드는 생년월일을 입력합니다.</p>
          <div className="mt-3 flex flex-col gap-3">
            <label className="text-xs text-foreground">
              사업자등록번호 또는 생년월일
              <input name="identity" inputMode="numeric" maxLength={10} pattern="[0-9]{6}|[0-9]{10}"
                placeholder="사업자번호 10자리 / 생년월일 6자리" className={INPUT} />
            </label>
            <label className="text-xs text-foreground">
              카드 비밀번호 앞 2자리
              <input name="password" type="password" inputMode="numeric" autoComplete="new-password"
                maxLength={2} pattern="[0-9]{2}" placeholder="앞 2자리" className={INPUT} />
            </label>
          </div>
        </details>
        <label className="flex items-start gap-2 text-xs leading-relaxed text-foreground">
          <input type="checkbox" required name="consent" className="mt-0.5 size-4 shrink-0 accent-primary" />
          위 자동결제 금액과 조건을 확인했으며, 이 카드의 자동결제 등록에 동의합니다.
        </label>
        {!buyerReady && <p className="text-xs text-destructive">위 구매자 정보를 먼저 채워 주세요.</p>}
        <div className="flex justify-end gap-2">
          {replacing && <Button type="button" variant="outline" size="sm" onClick={onCancel}>취소</Button>}
          <Button type="submit" size="sm" disabled={!buyerReady || busy}>
            {busy ? "카드 확인 중…" : "동의하고 카드 등록"}
          </Button>
        </div>
        <p role="status" className="text-[11px] leading-relaxed text-muted-foreground">
          {busy ? "카드 등록 결과를 확인하고 있습니다. 잠시 기다려 주세요." : "카드번호와 추가 확인정보는 등록에만 사용하며 저장하지 않습니다."}
        </p>
      </fieldset>
    </form>
  );
}
