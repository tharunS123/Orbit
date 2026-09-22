'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, CalendarCheck, CloudOff, Mic, Sparkles, Users, Workflow } from 'lucide-react';
import { PRODUCT } from '@orbit/shared';
import { Button, Spinner } from '@orbit/ui';
import { Logo } from '@/components/brand';
import { useSession } from '@/lib/session';

const FEATURES = [
  { icon: Workflow, title: 'Tasks inside your notes', body: 'Start with a checklist, grow it into a project. Headings, notes, files and subtasks live right next to the work.' },
  { icon: CloudOff, title: 'Works offline', body: 'Everything is saved on your device first and syncs quietly when you are back online. Nothing waits on the network.' },
  { icon: Users, title: 'Built for two or twenty', body: 'Share a list, edit together in real time, assign, comment and see what changed.' },
  { icon: Mic, title: 'Say it, it’s organised', body: 'Talk through your to-dos and review a clean list of tasks, dates and subtasks before anything is saved.' },
  { icon: Sparkles, title: 'Meeting notes that act', body: 'Record a meeting, get a summary, decisions and action items with links back to the exact moment.' },
  { icon: CalendarCheck, title: 'Your day at a glance', body: 'Today and Upcoming pull in due tasks and calendar events so planning takes seconds.' },
];

export default function Home() {
  const { session, loading } = useSession();
  const router = useRouter();

  React.useEffect(() => {
    if (session) router.replace('/inbox');
  }, [session, router]);

  if (loading || session) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <Spinner className="size-5" />
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-bg">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Logo />
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild variant="primary" size="sm">
            <Link href="/signup">Get started</Link>
          </Button>
        </nav>
      </header>
      <section className="mx-auto max-w-4xl px-5 pt-16 pb-12 text-center sm:pt-24">
        <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-accent-subtle px-3 py-1 text-[13px] font-medium text-accent-subtle-fg">{PRODUCT.tagline}</p>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">The calm place for everything you need to get done.</h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-pretty text-fg-muted">
          {PRODUCT.name} blends a fast task manager with living documents, real-time collaboration and AI that turns conversations into next steps.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild variant="primary" size="lg">
            <Link href="/signup">
              Create your free account <ArrowRight />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link href="/login">I already have an account</Link>
          </Button>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-4 px-5 pb-24 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <article key={f.title} className="rounded-xl border border-border bg-surface p-6 shadow-xs">
            <f.icon className="mb-4 size-6 text-accent" aria-hidden />
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">{f.body}</p>
          </article>
        ))}
      </section>
      <footer className="border-t border-border py-8 text-center text-sm text-fg-subtle">
        © {new Date().getFullYear()} {PRODUCT.name}
      </footer>
    </main>
  );
}
