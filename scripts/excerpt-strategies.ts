export type EvidenceView = "head-tail" | "head-middle-tail" | "full";
export const VIEWS: EvidenceView[] = ["head-tail", "head-middle-tail", "full"];

/** Character payload budgets exclude omission markers, as in the production excerpt. */
export function evidenceExcerpt(text: string, view: EvidenceView, limit = 800): string {
  if (view === "full" || text.length <= limit) return text;
  if (view === "head-tail") {
    const half = Math.floor(limit / 2);
    return `${text.slice(0, half)}\n[… omitted …]\n${text.slice(-half)}`;
  }
  const head = Math.floor(limit / 3);
  const middle = Math.floor(limit / 3);
  const tail = limit - head - middle;
  const start = Math.floor((text.length - middle) / 2);
  return `${text.slice(0, head)}\n[… omitted …]\n${text.slice(start, start + middle)}\n[… omitted …]\n${text.slice(-tail)}`;
}
