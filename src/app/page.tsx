import { RobotIllustration } from "@/components/home/robot-illustration";
import { Button } from "@/components/ui/button";
import { ArrowIcon } from "@/components/ui/arrow-icon";
import { Container } from "@/components/ui/container";
import { contributionDimensions, site } from "@/lib/config/site";

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line py-6">
        <Container className="flex items-center justify-between gap-4">
          <span className="text-sm font-semibold tracking-widest">{site.name}</span>
          <span className="text-xs text-muted sm:text-sm">A story we make together</span>
        </Container>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1">
        <Container>
          <section aria-labelledby="home-title" className="grid items-center gap-6 py-12 sm:py-16 md:grid-cols-[1.3fr_1fr] md:gap-12 md:py-20">
            <div>
              <p className="eyebrow mb-6">Love begins with connection</p>
              <h1 id="home-title" className="text-5xl font-semibold leading-[1.04] tracking-[-0.055em] sm:text-7xl lg:text-8xl">WHAT IS<br />LOVE<span className="text-accent">?</span></h1>
              <p className="mt-7 max-w-md text-xl leading-relaxed sm:text-2xl">{site.description}</p>
              <p className="mt-4 max-w-md leading-relaxed text-muted">An invitation to share the people, places, and little moments that make us feel we belong.</p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Button disabled aria-describedby="room-availability">Create a Robot <ArrowIcon /></Button>
                <Button variant="secondary" disabled aria-describedby="room-availability">Join a Robot <ArrowIcon /></Button>
              </div>
              <p id="room-availability" className="mt-3 text-sm text-muted">Coming in the next phase · Room creation and joining are not available yet.</p>
            </div>
            <div className="mx-auto w-full max-w-[280px] sm:max-w-[340px] md:max-w-[400px]">
              <RobotIllustration />
            </div>
          </section>

          <section aria-labelledby="dimensions-title" className="border-t border-line pb-14 pt-9 sm:pb-20">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <h2 id="dimensions-title" className="text-lg font-medium">Six ways to explore one big question.</h2>
              <p className="text-sm text-muted">Your stories will be its beginning.</p>
            </div>
            <ul className="mt-7 grid grid-cols-2 gap-x-6 gap-y-7 sm:grid-cols-3 lg:grid-cols-6">
              {contributionDimensions.map((dimension) => (
                <li key={dimension.id}>
                  <h3 className="eyebrow text-ink">{dimension.label}</h3>
                  <p className="mt-2 max-w-40 text-sm leading-relaxed text-muted">{dimension.description}</p>
                </li>
              ))}
            </ul>
          </section>
        </Container>
      </main>

      <footer className="border-t border-line py-5">
        <Container className="flex flex-col justify-between gap-2 text-xs text-muted sm:flex-row">
          <p>A collaborative storytelling experience about love &amp; belonging.</p>
          <p>Every connection starts somewhere.</p>
        </Container>
      </footer>
    </div>
  );
}
