import { HighlightsView } from "@/components/highlights-view";

export default async function ProgramHighlightsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HighlightsView programId={id} />;
}