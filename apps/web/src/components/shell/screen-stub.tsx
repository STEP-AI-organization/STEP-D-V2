/**
 * 아직 채우지 않은 화면 자리.
 *
 * 빈 화면을 그냥 두면 "아직 안 만든 것"과 "서버가 안 붙은 것"이 같아 보인다.
 * 무엇이 올 자리이고 어느 단계에서 오는지 화면에 적어 둔다 —
 * 재설계가 화면 단위로 진행되는 동안 이게 진행 현황판 역할을 한다.
 */
export function ScreenStub({
  title,
  plan,
  pr,
}: {
  title: string;
  plan: string;
  pr: string;
}) {
  return (
    <div className="sd-card mx-auto max-w-[720px] p-6">
      <div className="sd-eb mb-2" style={{ color: "var(--sd-label)" }}>
        {pr} · 구현 예정
      </div>
      <h2 className="sd-serif mb-2 text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
        {title}
      </h2>
      <p className="text-[12px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
        {plan}
      </p>
      <p className="mt-3 text-[11px]" style={{ color: "var(--sd-idle)" }}>
        화면은 아직 비어 있습니다 — 서버 연결 문제가 아닙니다. 사이드바 하단에서 연결 상태를 확인할 수 있습니다.
      </p>
    </div>
  );
}
