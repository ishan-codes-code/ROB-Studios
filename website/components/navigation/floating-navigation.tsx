"use client";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { NAV_SECTIONS } from "@/lib/sample-data";

export default function FloatingNavigation() {
  const [active, setActive] = useState("hero");
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const ids = ["hero", ...NAV_SECTIONS.map((s) => s.id), "closing"];
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) if (e.isIntersecting) setActive(e.target.id); },
      { rootMargin: "-38% 0px -55% 0px" }
    );
    els.forEach((el) => io.observe(el));
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { io.disconnect(); window.removeEventListener("scroll", onScroll); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open ]);

  const go = (id: string) => { setOpen(false); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); };

  return (
    <header className="floating-nav" data-scrolled={scrolled}>
      <a href="#hero" onClick={(e) => { e.preventDefault(); go("hero"); }} className="floating-nav-brand" aria-label="AI Commentator — back to top">
        <span className="size-1.5 rounded-full bg-white" aria-hidden="true" /> AI COMMENTATOR
      </a>
      <nav className="floating-nav-links" aria-label="Sections">
        {NAV_SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); go(s.id); }} aria-current={active === s.id ? "true" : undefined} className="floating-nav-link" data-active={active === s.id}>
            <span className="font-mono text-[9px] text-zinc-600">{s.num}</span>{s.label}
          </a>
        ))}
      </nav>
      <span className="hidden font-mono text-[9px] tracking-[0.2em] text-zinc-600 lg:block" aria-hidden="true">{active.toUpperCase()}</span>
      <button type="button" className="floating-nav-toggle" aria-expanded={open} aria-label={open ? "Close navigation" : "Open navigation"} onClick={() => setOpen((v) => !v)}>
        {open ? <X className="size-4" /> : <Menu className="size-4" />}
      </button>
      {open && (
        <nav className="floating-nav-mobile" aria-label="Sections mobile">
          {NAV_SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); go(s.id); }} aria-current={active === s.id ? "true" : undefined} className="floating-nav-mobile-link" data-active={active === s.id}>{s.num} — {s.label}</a>
          ))}
        </nav>
      )}
    </header>
  );
}
