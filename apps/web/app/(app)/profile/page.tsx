'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Flame, Trophy, UserRound } from 'lucide-react';
import { addDays, isoWeekday, todayIn } from '@orbit/core';
import { Avatar, Segmented, Spinner, cn } from '@orbit/ui';
import { PageBody, PageHeader } from '@/features/shell/page-header';
import { apiFetch } from '@/lib/api';
import { useSignedImage } from '@/lib/images';
import { useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';

interface Heatmap {
  days: { day: string; count: number }[];
  total: number;
  bestDay: { day: string; count: number } | null;
  currentStreak: number;
  activeDays: number;
}

const LEVELS = ['bg-bg-active', 'bg-success/30', 'bg-success/55', 'bg-success/80', 'bg-success'];

function HeatmapGrid({ data, days, today }: { data: Heatmap; days: number; today: string }) {
  const counts = new Map(data.days.map((d) => [d.day, d.count]));
  const max = Math.max(1, ...data.days.map((d) => d.count));
  const end = today;
  const start = addDays(end, -(days - 1));
  const gridStart = addDays(start, -isoWeekday(start));
  const cells: string[] = [];
  for (let d = gridStart; d <= end; d = addDays(d, 1)) cells.push(d);
  const weeks: string[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  return (
    <div className="overflow-x-auto pb-2">
      <div className="inline-flex gap-[3px]" role="img" aria-label={`Completed tasks per day over the last ${days} days`}>
        {weeks.map((w, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {w.map((d) => {
              const n = counts.get(d) ?? 0;
              const out = d < start;
              return <div key={d} title={`${d}: ${n} completed`} className={cn('size-3 rounded-[3px]', out ? 'bg-transparent' : LEVELS[level(n)])} />;
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1 text-[11px] text-fg-subtle" aria-hidden>
        Less {LEVELS.map((c) => <span key={c} className={cn('size-3 rounded-[3px]', c)} />)} More
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const { timeZone } = useSync();
  const { profile } = useWorkspace();
  const avatar = useSignedImage(profile?.avatarPath);
  const [range, setRange] = React.useState<'90' | '365'>('90');
  const q = useQuery({ queryKey: ['heatmap', range, timeZone], queryFn: () => apiFetch<Heatmap>(`/me/heatmap?days=${range}&tz=${encodeURIComponent(timeZone)}`) });
  const today = todayIn(timeZone);
  return (
    <>
      <PageHeader title="Profile" icon={<UserRound />} />
      <PageBody>
        <div className="mt-4 flex items-center gap-4">
          <Avatar name={profile?.displayName ?? 'You'} src={avatar} seed={profile?.id} size={64} />
          <div>
            <p className="text-lg font-semibold">{profile?.displayName}</p>
            <p className="text-sm text-fg-muted">{profile?.email}</p>
          </div>
        </div>
        <section className="mt-8 rounded-xl border border-border bg-surface p-5" aria-labelledby="activity-heading">
          <div className="mb-4 flex items-center justify-between">
            <h2 id="activity-heading" className="font-semibold">
              Completed tasks
            </h2>
            <Segmented ariaLabel="Range" value={range} onValueChange={setRange} options={[{ value: '90', label: '90 days' }, { value: '365', label: '1 year' }]} />
          </div>
          {q.isLoading ? (
            <Spinner />
          ) : q.data ? (
            <>
              <HeatmapGrid data={q.data} days={Number(range)} today={today} />
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-surface-sunken p-3">
                  <dt className="text-xs text-fg-muted">Completed</dt>
                  <dd className="text-xl font-semibold tabular-nums">{q.data.total}</dd>
                </div>
                <div className="rounded-lg bg-surface-sunken p-3">
                  <dt className="text-xs text-fg-muted">Active days</dt>
                  <dd className="text-xl font-semibold tabular-nums">{q.data.activeDays}</dd>
                </div>
                <div className="rounded-lg bg-surface-sunken p-3">
                  <dt className="flex items-center gap-1 text-xs text-fg-muted">
                    <Flame className="size-3.5" /> Current streak
                  </dt>
                  <dd className="text-xl font-semibold tabular-nums">
                    {q.data.currentStreak} day{q.data.currentStreak === 1 ? '' : 's'}
                  </dd>
                </div>
                <div className="rounded-lg bg-surface-sunken p-3">
                  <dt className="flex items-center gap-1 text-xs text-fg-muted">
                    <Trophy className="size-3.5" /> Best day
                  </dt>
                  <dd className="text-xl font-semibold tabular-nums">{q.data.bestDay ? `${q.data.bestDay.count}` : '—'}</dd>
                  {q.data.bestDay ? <dd className="text-[11px] text-fg-subtle">{q.data.bestDay.day}</dd> : null}
                </div>
              </dl>
            </>
          ) : (
            <p className="text-sm text-fg-muted">Activity is available when you’re online.</p>
          )}
        </section>
      </PageBody>
    </>
  );
}
