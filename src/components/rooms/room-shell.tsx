import Link from "next/link";
import type { ReactNode } from "react";
import { Container } from "@/components/ui/container";
import { site } from "@/lib/config/site";

export function RoomShell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh flex-col">
    <header className="border-b border-line py-6"><Container className="flex items-center justify-between gap-4">
      <Link href="/" className="text-sm font-semibold tracking-widest">{site.name}</Link>
      <span className="text-xs text-muted sm:text-sm">A story we make together</span>
    </Container></header>
    <main id="main-content" tabIndex={-1} className="flex-1"><Container className="py-9 sm:py-14">
      <Link href="/" className="text-sm text-muted underline underline-offset-4">← Welcome</Link>
      {children}
    </Container></main>
    <footer className="border-t border-line py-5"><Container><p className="text-xs text-muted">Every connection starts somewhere.</p></Container></footer>
  </div>;
}
