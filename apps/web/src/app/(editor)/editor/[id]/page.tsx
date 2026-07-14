import { EditorShell } from "@/components/editor/editor-shell";

/**
 * Editor v2 — full-screen (own route group, outside app chrome).
 * `id` is a clipId. See docs/step-d-ux-plan.md §7.4.
 */
export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditorShell clipId={id} />;
}
