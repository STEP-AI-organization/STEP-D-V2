import { EditorShell } from "@/components/editor/editor-shell";

/**
 * Editor v2 — full-screen (own route group, outside app chrome).
 * `id` is a clipId. See docs/plans/step-d-master-build-plan.md §7 (편집기 통합).
 */
export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditorShell clipId={id} />;
}
