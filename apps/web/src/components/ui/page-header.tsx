export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  /** Brand-tinted kicker above the title (Review OS pattern, e.g. "소스 영상 라이브러리"). */
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="text-eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="text-page-title">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
