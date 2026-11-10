export const PAGES: Record<"privacy" | "terms", { title: string; other: { href: string; label: string } }>;
export function inline(text: string): string;
export function renderBody(markdown: string): { heading: string; html: string };
export function renderPage(kind: "privacy" | "terms", markdown: string): string;
export function sourcePath(kind: "privacy" | "terms"): string;
export function outputPath(kind: "privacy" | "terms"): string;
