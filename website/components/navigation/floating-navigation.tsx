"use client";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { NAV_SECTIONS } from "@/lib/sample-data";

const IDS = ["hero", ...NAV_SECTIONS.map((s) => s.id), "closing"];

export default function FloatingNavigation() {
  const [active, setActive] = useState("hero");
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const els = IDS.map((id) => document.getElementById(id)).filter(
      Boolean
    ) as HTMLElement[];
    // Deterministic: keep the full set of sections intersecting the
    // reading band, then always pick the deepest one in document order
    // (the incoming/foreground scene during sticky overlap). Callback
    // entry order no longer matters.
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const current = IDS.filter((id) => visible.has(id)).at(-1);
        if (current) setActive(current);
      },
      { rootMargin: "-38% 0px -55% 0px" }
    );
    els.forEach((el) => io.observe(el));
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onResize = () => {
      if (window.innerWidth > 900) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open ]);

  const go = (id: string) => {
    setOpen(false);
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

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
      <button ref={toggleRef} type="button" className="floating-nav-toggle" aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? "Close navigation" : "Open navigation"} onClick={() => setOpen((v) => !v)}>
        {open ? <X className="size-4" /> : <Menu className="size-4" />}
      </button>
      {open && (
        <nav id="mobile-nav" className="floating-nav-mobile" aria-label="Sections mobile">
          {NAV_SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); go(s.id); }} aria-current={active === s.id ? "true" : undefined} className="floating-nav-mobile-link" data-active={active === s.id}>{s.num} — {s.label}</a>
          ))}
        </nav>
      )}
    </header>
  );
}
