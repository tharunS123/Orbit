'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Bell, Calendar, Check, Loader2, Upload, User, Users } from 'lucide-react';
import { AppError, describeError, routes, uuidv7 } from '@orbit/shared';
import { TEMPLATES } from '@orbit/core';
import { Avatar, Button, Field, Input, Textarea, cn, toast } from '@orbit/ui';
import { LogoMark } from '@/components/brand';
import { createListFromTemplate } from '@/features/lists/templates';
import { apiFetch } from '@/lib/api';
import { useCollab, useMe } from '@/lib/collab';
import { enableWebPush, pushSupported } from '@/lib/push';
import { useSignedImage } from '@/lib/images';
import { detectTimeZone, useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';

const STEPS = ['profile', 'usage', 'team', 'templates', 'notifications'] as const;
type Step = (typeof STEPS)[number];

export default function OnboardingPage() {
  const router = useRouter();
  const { client, actions } = useSync();
  const { profile, workspaces, setWorkspace } = useWorkspace();
  const collab = useCollab();
  const me = useMe();
  const personal = workspaces.find((w) => w.kind === 'personal');
  const [step, setStep] = React.useState<Step>('profile');
  const [name, setName] = React.useState(profile?.displayName ?? '');
  const [usage, setUsage] = React.useState<'personal' | 'team'>('personal');
  const [teamName, setTeamName] = React.useState('');
  const [emails, setEmails] = React.useState('');
  const [picked, setPicked] = React.useState<string[]>(['weekly-planning', 'grocery']);
  const [busy, setBusy] = React.useState(false);
  const avatar = useSignedImage(profile?.avatarPath);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (profile?.displayName && !name) setName(profile.displayName);
  }, [profile?.displayName]); // eslint-disable-line react-hooks/exhaustive-deps

  const idx = STEPS.indexOf(step);
  const visibleSteps = STEPS.filter((s) => s !== 'team' || usage === 'team');
  const next = () => {
    const order = visibleSteps;
    const i = order.indexOf(step);
    if (i < order.length - 1) setStep(order[i + 1]!);
    else void finish();
  };

  const uploadAvatar = async (file: File) => {
    try {
      const { uploadUrl, path } = await apiFetch<{ uploadUrl: string; path: string }>('/uploads/image-url', { method: 'POST', body: { kind: 'avatar', mimeType: file.type, sizeBytes: file.size } });
      const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
      if (!res.ok) throw new Error('upload failed');
      client.mutate('profile.update', { avatarPath: path });
    } catch {
      toast.error('Couldn’t upload that image. You can add one later in Settings.');
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      let target = personal?.id ?? workspaces[0]?.id;
      if (usage === 'team' && teamName.trim()) {
        const id = uuidv7();
        client.mutate('workspace.create', { id, memberId: uuidv7(), name: teamName.trim() });
        target = id;
        const list = emails.split(/[\s,;]+/).map((e) => e.trim()).filter((e) => /.+@.+\..+/.test(e));
        if (list.length) {
          await client.sync();
          await apiFetch('/invitations', { method: 'POST', body: { workspaceId: id, emails: list, role: 'member' } }).catch((e: unknown) => toast.error(describeError(AppError.from(e))));
        }
        setWorkspace(id);
      }
      if (target) {
        for (const tid of picked) {
          const t = TEMPLATES.find((x) => x.id === tid);
          if (t) await createListFromTemplate(actions, collab, target, t);
        }
        actions.createTask({ workspaceId: target, text: 'Try adding a task: “Call Alex tomorrow at 3pm #work”', parse: false, inInbox: true });
      }
      client.mutate('profile.update', { displayName: name.trim() || profile?.displayName || 'Me', usageType: usage, timezone: detectTimeZone(), onboarded: true });
      router.replace(routes.inbox());
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg px-4 py-10">
      <LogoMark size={36} />
      <ol className="mt-6 flex gap-1.5" aria-label="Progress">
        {visibleSteps.map((s, i) => (
          <li key={s} className={cn('h-1.5 w-8 rounded-full', i <= visibleSteps.indexOf(step) ? 'bg-accent' : 'bg-border')} aria-current={s === step ? 'step' : undefined}>
            <span className="sr-only">{s}</span>
          </li>
        ))}
      </ol>
      <div className="mt-8 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        {step === 'profile' ? (
          <>
            <h1 className="text-xl font-semibold">Welcome! What should we call you?</h1>
            <p className="mt-1 text-sm text-fg-muted">This is how collaborators will see you.</p>
            <div className="mt-6 flex items-center gap-4">
              <Avatar name={name || 'You'} src={avatar} seed={profile?.id} size={56} />
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload /> Add a photo
              </Button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadAvatar(e.target.files[0])} />
            </div>
            <Field label="Display name" htmlFor="ob-name" className="mt-5">
              <Input id="ob-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && next()} />
            </Field>
          </>
        ) : null}
        {step === 'usage' ? (
          <>
            <h1 className="text-xl font-semibold">How will you use it?</h1>
            <p className="mt-1 text-sm text-fg-muted">You can always create a team workspace later.</p>
            <div className="mt-6 grid gap-3">
              {([
                { value: 'personal', icon: User, title: 'For myself', body: 'Personal tasks, notes and plans.' },
                { value: 'team', icon: Users, title: 'With my team', body: 'Shared projects, assignments and meetings.' },
              ] as const).map((o) => (
                <button key={o.value} type="button" onClick={() => setUsage(o.value)} aria-pressed={usage === o.value} className={cn('flex items-start gap-3 rounded-lg border p-4 text-left transition-colors', usage === o.value ? 'border-accent bg-accent-subtle/40' : 'border-border hover:bg-bg-hover')}>
                  <o.icon className="mt-0.5 size-5 text-accent" aria-hidden />
                  <span>
                    <span className="block font-medium">{o.title}</span>
                    <span className="text-sm text-fg-muted">{o.body}</span>
                  </span>
                  {usage === o.value ? <Check className="ml-auto size-4 text-accent" /> : null}
                </button>
              ))}
            </div>
          </>
        ) : null}
        {step === 'team' ? (
          <>
            <h1 className="text-xl font-semibold">Create your team workspace</h1>
            <Field label="Workspace name" htmlFor="ob-team" className="mt-6">
              <Input id="ob-team" autoFocus value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Acme Design" />
            </Field>
            <Field label="Invite teammates (optional)" htmlFor="ob-invite" hint="Separate emails with commas. They’ll get an invitation." className="mt-4">
              <Textarea id="ob-invite" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="sam@acme.com, alex@acme.com" />
            </Field>
          </>
        ) : null}
        {step === 'templates' ? (
          <>
            <h1 className="text-xl font-semibold">Start with a few lists</h1>
            <p className="mt-1 text-sm text-fg-muted">Pick any — they’re ordinary lists you can edit or delete.</p>
            <div className="mt-5 grid gap-2">
              {TEMPLATES.map((t) => {
                const on = picked.includes(t.id);
                return (
                  <button key={t.id} type="button" aria-pressed={on} onClick={() => setPicked(on ? picked.filter((p) => p !== t.id) : [...picked, t.id])} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2 text-left', on ? 'border-accent bg-accent-subtle/40' : 'border-border hover:bg-bg-hover')}>
                    <span className="text-xl" aria-hidden>
                      {t.emoji}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{t.title}</span>
                      <span className="block truncate text-xs text-fg-muted">{t.description}</span>
                    </span>
                    {on ? <Check className="size-4 text-accent" /> : null}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        {step === 'notifications' ? (
          <>
            <h1 className="text-xl font-semibold">Stay on top of things</h1>
            <p className="mt-1 text-sm text-fg-muted">Optional — you can change these any time in Settings.</p>
            <div className="mt-6 flex flex-col gap-3">
              <div className="flex items-center gap-3 rounded-lg border border-border p-4">
                <Bell className="size-5 text-accent" aria-hidden />
                <span className="flex-1 text-sm">Reminders and mentions as notifications</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!pushSupported()}
                  onClick={() =>
                    void enableWebPush(me.data?.vapidPublicKey ?? null)
                      .then((p) => (p === 'granted' ? toast.success('Notifications enabled') : toast('Notifications not allowed')))
                      .catch((e: unknown) => toast.error(describeError(AppError.from(e))))
                  }
                >
                  Enable
                </Button>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-border p-4">
                <Calendar className="size-5 text-accent" aria-hidden />
                <span className="flex-1 text-sm">See calendar events in Today</span>
                <Button size="sm" variant="secondary" onClick={() => window.open(routes.settings('integrations'), '_blank')}>
                  Connect later
                </Button>
              </div>
            </div>
          </>
        ) : null}
        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={() => (idx > 0 ? setStep(visibleSteps[Math.max(0, visibleSteps.indexOf(step) - 1)]!) : void finish())} disabled={busy}>
            {idx > 0 ? 'Back' : 'Skip setup'}
          </Button>
          <Button variant="primary" onClick={next} disabled={busy || (step === 'profile' && !name.trim()) || (step === 'team' && !teamName.trim())}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {step === 'notifications' ? 'Go to my Inbox' : 'Continue'} <ArrowRight />
          </Button>
        </div>
      </div>
    </main>
  );
}
