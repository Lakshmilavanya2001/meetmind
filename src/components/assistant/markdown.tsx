import Link from "next/link";
import { Fragment } from "react";

// Minimal, safe Markdown for assistant replies: paragraphs, bullet/numbered lists, **bold**, `code`, [links](url).
// Builds React nodes (no HTML injection). Links are limited to this app's paths and http(s) URLs.

function safeHref(url: string): string | null {
  if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Same-app absolute links (e.g. APP_URL/m/code) become relative so they stay in the SPA.
    if (typeof window !== "undefined" && u.host === window.location.host) return u.pathname + u.search;
    return u.toString();
  } catch {
    return null;
  }
}

function inline(text: string, key: string) {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<strong key={k}>{m[1]}</strong>);
    else if (m[2]) out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{m[2]}</code>);
    else {
      const href = safeHref(m[4]);
      if (!href) out.push(m[3]);
      else if (href.startsWith("/")) out.push(<Link key={k} href={href} className="font-medium text-primary underline underline-offset-2">{m[3]}</Link>);
      else out.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-2">{m[3]}</a>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{para.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l, `p${blocks.length}-${i}`)}</Fragment>)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `l${blocks.length}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={`o${blocks.length}`} className="list-decimal pl-5">{items}</ol> : <ul key={`u${blocks.length}`} className="list-disc pl-5">{items}</ul>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.replace(/^#{1,6}\s+/, ""));
    }
  }
  flushPara();
  flushList();
  return <div className="grid gap-2 text-sm leading-relaxed">{blocks}</div>;
}
