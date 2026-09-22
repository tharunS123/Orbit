'use client';

import * as React from 'react';
import { ArrowRight, Bell, CalendarDays, Check, Inbox, ListTodo, Repeat, Sofa, Sun, Sunrise, Tag, UserRound, X } from 'lucide-react';
import { LABEL_COLORS, uuidv7, type LabelColor, type Recurrence, type Reminder, type Weekday } from '@orbit/shared';
import { addDays, describeRecurrence, formatCivilLong, isoWeekday, normalizeRecurrence, parseTaskInput, todayIn } from '@orbit/core';
import { selectAssignable, selectLabels, selectListTree, type ListNode } from '@orbit/sync/client';
import {
  Avatar,
  Button,
  Calendar,
  ColorDot,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  LabelChip,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  cn,
} from '@orbit/ui';
import { useStoreQuery, useSync } from '@/lib/sync';

/** Uncontrolled by default; controlled when `open` is passed (keyboard/menu-triggered pickers). */
export interface ControlledOpen {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function useOpenState({ open, onOpenChange }: ControlledOpen): [boolean, (o: boolean) => void] {
  const [inner, setInner] = React.useState(false);
  const controlled = open !== undefined;
  return [controlled ? open : inner, (o: boolean) => (controlled ? onOpenChange?.(o) : setInner(o))];
}

// ───────────── Date ─────────────
export interface DueValue {
  dueDate: string | null;
  dueTime: string | null;
}

function nextWeekday(from: string, weekday: number): string {
  const diff = (weekday - isoWeekday(from) + 7) % 7 || 7;
  return addDays(from, diff);
}

export function DatePickerPanel({ value, onChange, onClose }: { value: DueValue; onChange: (v: DueValue) => void; onClose?: () => void }) {
  const { timeZone } = useSync();
  const today = todayIn(timeZone);
  const [text, setText] = React.useState('');
  const [time, setTime] = React.useState(value.dueTime?.slice(0, 5) ?? '');
  const parsed = React.useMemo(() => (text.trim() ? parseTaskInput(`x ${text}`, { timeZone }) : null), [text, timeZone]);
  const quick = [
    { label: 'Today', icon: Sun, date: today },
    { label: 'Tomorrow', icon: Sunrise, date: addDays(today, 1) },
    { label: 'This weekend', icon: Sofa, date: isoWeekday(today) >= 5 ? addDays(today, 1) : nextWeekday(today, 5) },
    { label: 'Next week', icon: ArrowRight, date: nextWeekday(today, 0) },
  ];
  const pick = (date: string | null, t: string | null = time || null) => {
    onChange({ dueDate: date, dueTime: date ? t : null });
    onClose?.();
  };
  return (
    <div className="flex w-[268px] flex-col gap-2">
      <Input
        autoFocus
        placeholder="Type a date: “fri 3pm”, “in 2 weeks”…"
        className="h-9"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && parsed?.dueDate) {
            e.preventDefault();
            pick(parsed.dueDate, parsed.dueTime ?? (time || null));
          }
        }}
        aria-label="Type a date"
      />
      {parsed?.dueDate ? (
        <button type="button" className="rounded-md bg-accent-subtle px-2 py-1.5 text-left text-[13px] text-accent-subtle-fg" onClick={() => pick(parsed.dueDate, parsed.dueTime ?? (time || null))}>
          {formatCivilLong(parsed.dueDate)}
          {parsed.dueTime ? ` at ${parsed.dueTime}` : ''}
        </button>
      ) : null}
      <div className="grid grid-cols-2 gap-1">
        {quick.map((q) => (
          <button key={q.label} type="button" onClick={() => pick(q.date)} className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] hover:bg-bg-hover">
            <q.icon className="size-4 text-fg-muted" aria-hidden />
            {q.label}
          </button>
        ))}
      </div>
      <Calendar value={value.dueDate} today={today} onSelect={(d) => pick(d)} />
      <div className="flex items-center gap-2 border-t border-border pt-2">
        <label className="flex items-center gap-2 text-[13px] text-fg-muted">
          Time
          <input
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              if (value.dueDate) onChange({ dueDate: value.dueDate, dueTime: e.target.value || null });
            }}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
          />
        </label>
        {value.dueDate ? (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => pick(null)}>
            <X /> Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function DatePicker({ value, onChange, children, ...ctl }: { value: DueValue; onChange: (v: DueValue) => void; children: React.ReactElement } & ControlledOpen) {
  const [open, setOpen] = useOpenState(ctl);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent>
        <DatePickerPanel value={value} onChange={onChange} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

// ───────────── Reminders ─────────────
const PRESETS: { minutes: number; label: string }[] = [
  { minutes: 0, label: 'At time of task' },
  { minutes: 5, label: '5 minutes before' },
  { minutes: 15, label: '15 minutes before' },
  { minutes: 30, label: '30 minutes before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 1440, label: '1 day before' },
];

export function describeReminder(r: Reminder, hasTime: boolean): string {
  if (r.kind === 'absolute') return new Date(r.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const preset = PRESETS.find((p) => p.minutes === r.offsetMinutes);
  if (!hasTime && r.offsetMinutes === 0) return 'Morning of';
  if (preset) return preset.label;
  if (r.offsetMinutes % 1440 === 0) return `${r.offsetMinutes / 1440} days before`;
  if (r.offsetMinutes % 60 === 0) return `${r.offsetMinutes / 60} hours before`;
  return `${r.offsetMinutes} minutes before`;
}

export function ReminderPicker({ reminders, hasDue, hasTime, onChange, children, ...ctl }: { reminders: Reminder[]; hasDue: boolean; hasTime: boolean; onChange: (r: Reminder[]) => void; children: React.ReactElement } & ControlledOpen) {
  const [open, setOpen] = useOpenState(ctl);
  const [custom, setCustom] = React.useState('');
  const toggle = (minutes: number) => {
    const exists = reminders.find((r) => r.kind === 'relative' && r.offsetMinutes === minutes);
    onChange(exists ? reminders.filter((r) => r !== exists) : [...reminders, { id: uuidv7(), kind: 'relative', offsetMinutes: minutes }]);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64">
        {!hasDue ? <p className="px-2 py-1.5 text-xs text-fg-muted">Relative reminders need a due date. You can still add an exact reminder below.</p> : null}
        <div className="flex flex-col">
          {PRESETS.filter((p) => hasTime || p.minutes === 0 || p.minutes === 1440).map((p) => {
            const on = reminders.some((r) => r.kind === 'relative' && r.offsetMinutes === p.minutes);
            return (
              <button key={p.minutes} type="button" disabled={!hasDue} onClick={() => toggle(p.minutes)} className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-bg-hover disabled:opacity-40">
                <Check className={cn('size-4', on ? 'text-accent' : 'invisible')} aria-hidden />
                {!hasTime && p.minutes === 0 ? 'Morning of' : p.label}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
          <label className="px-1 text-xs font-medium text-fg-muted" htmlFor="custom-reminder">
            Exact time
          </label>
          <div className="flex gap-1">
            <input id="custom-reminder" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-[13px]" />
            <Button
              size="sm"
              variant="secondary"
              disabled={!custom}
              onClick={() => {
                onChange([...reminders, { id: uuidv7(), kind: 'absolute', at: new Date(custom).toISOString() }]);
                setCustom('');
              }}
            >
              Add
            </Button>
          </div>
        </div>
        {reminders.some((r) => r.kind === 'absolute') ? (
          <div className="mt-2 flex flex-col gap-1">
            {reminders
              .filter((r) => r.kind === 'absolute')
              .map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-md bg-bg-hover px-2 py-1 text-xs">
                  {describeReminder(r, true)}
                  <button type="button" aria-label="Remove reminder" onClick={() => onChange(reminders.filter((x) => x.id !== r.id))}>
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ───────────── Recurrence ─────────────
const DAYS: { code: Weekday; short: string }[] = [
  { code: 'MO', short: 'M' },
  { code: 'TU', short: 'T' },
  { code: 'WE', short: 'W' },
  { code: 'TH', short: 'T' },
  { code: 'FR', short: 'F' },
  { code: 'SA', short: 'S' },
  { code: 'SU', short: 'S' },
];

export function RecurrencePicker({ value, dueDate, onChange, children, ...ctl }: { value: Recurrence | null; dueDate: string | null; onChange: (r: Recurrence | null, startDate?: string) => void; children: React.ReactElement } & ControlledOpen) {
  const { timeZone } = useSync();
  const today = todayIn(timeZone);
  const base = dueDate ?? today;
  const [draft, setDraft] = React.useState<Recurrence>(value ?? { freq: 'weekly', interval: 1, anchor: 'schedule', byWeekday: [(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as Weekday[])[isoWeekday(base)]!] });
  const [open, setOpen] = useOpenState(ctl);
  const presets: { label: string; rule: Recurrence }[] = [
    { label: 'Every day', rule: { freq: 'daily', interval: 1, anchor: 'schedule' } },
    { label: 'Every weekday', rule: { freq: 'weekly', interval: 1, anchor: 'schedule', byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'] } },
    { label: 'Every week', rule: normalizeRecurrence({ freq: 'weekly', interval: 1, anchor: 'schedule' }, base) },
    { label: 'Every month', rule: normalizeRecurrence({ freq: 'monthly', interval: 1, anchor: 'schedule' }, base) },
    { label: 'Every year', rule: normalizeRecurrence({ freq: 'yearly', interval: 1, anchor: 'schedule' }, base) },
  ];
  const apply = (rule: Recurrence | null) => {
    onChange(rule, dueDate ?? today);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72">
        <div className="flex flex-col">
          {presets.map((p) => (
            <button key={p.label} type="button" onClick={() => apply(p.rule)} className="flex h-8 items-center rounded-md px-2 text-left text-[13px] hover:bg-bg-hover">
              {p.label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-col gap-2.5 border-t border-border px-1 pt-3">
          <p className="text-xs font-semibold text-fg-muted">Custom</p>
          <div className="flex items-center gap-2 text-[13px]">
            Every
            <input
              type="number"
              min={1}
              max={99}
              value={draft.interval}
              onChange={(e) => setDraft({ ...draft, interval: Math.max(1, Number(e.target.value) || 1) })}
              className="h-8 w-14 rounded-md border border-border bg-surface px-2"
              aria-label="Interval"
            />
            <select value={draft.freq} onChange={(e) => setDraft({ ...draft, freq: e.target.value as Recurrence['freq'] })} className="h-8 rounded-md border border-border bg-surface px-2" aria-label="Frequency">
              <option value="daily">{draft.interval > 1 ? 'days' : 'day'}</option>
              <option value="weekly">{draft.interval > 1 ? 'weeks' : 'week'}</option>
              <option value="monthly">{draft.interval > 1 ? 'months' : 'month'}</option>
              <option value="yearly">{draft.interval > 1 ? 'years' : 'year'}</option>
            </select>
          </div>
          {draft.freq === 'weekly' ? (
            <div className="flex gap-1" role="group" aria-label="Days of the week">
              {DAYS.map((d) => {
                const on = draft.byWeekday?.includes(d.code);
                return (
                  <button
                    key={d.code}
                    type="button"
                    aria-pressed={on}
                    aria-label={d.code}
                    onClick={() => {
                      const set = new Set(draft.byWeekday ?? []);
                      if (on) set.delete(d.code);
                      else set.add(d.code);
                      setDraft({ ...draft, byWeekday: DAYS.map((x) => x.code).filter((c) => set.has(c)) });
                    }}
                    className={cn('grid size-8 place-items-center rounded-full text-xs font-semibold', on ? 'bg-accent text-accent-fg' : 'bg-bg-hover text-fg-muted')}
                  >
                    {d.short}
                  </button>
                );
              })}
            </div>
          ) : null}
          {draft.freq === 'monthly' ? (
            <Segmented
              ariaLabel="Monthly pattern"
              value={draft.byNthWeekday ? 'nth' : 'day'}
              onValueChange={(v) => {
                const wd = (['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as Weekday[])[isoWeekday(base)]!;
                const nth = Math.ceil(Number(base.slice(8)) / 7);
                setDraft(v === 'nth' ? { ...draft, byMonthDay: undefined, byNthWeekday: { weekday: wd, nth: nth > 4 ? -1 : nth } } : { ...draft, byNthWeekday: undefined, byMonthDay: [Number(base.slice(8))] });
              }}
              options={[
                { value: 'day', label: `On day ${Number(base.slice(8))}` },
                { value: 'nth', label: 'On weekday' },
              ]}
            />
          ) : null}
          <div className="flex items-center gap-2 text-[13px]">
            <label className="flex items-center gap-2">
              Ends
              <select
                value={draft.count ? 'count' : draft.until ? 'until' : 'never'}
                onChange={(e) => setDraft({ ...draft, count: e.target.value === 'count' ? 10 : null, until: e.target.value === 'until' ? addDays(base, 90) : null })}
                className="h-8 rounded-md border border-border bg-surface px-2"
              >
                <option value="never">Never</option>
                <option value="until">On date</option>
                <option value="count">After</option>
              </select>
            </label>
            {draft.until ? <input type="date" value={draft.until} onChange={(e) => setDraft({ ...draft, until: e.target.value || null })} className="h-8 rounded-md border border-border bg-surface px-2" aria-label="End date" /> : null}
            {draft.count ? (
              <label className="flex items-center gap-1">
                <input type="number" min={1} value={draft.count} onChange={(e) => setDraft({ ...draft, count: Math.max(1, Number(e.target.value) || 1) })} className="h-8 w-16 rounded-md border border-border bg-surface px-2" aria-label="Occurrences" />
                times
              </label>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-[13px] text-fg-muted">
            <input type="checkbox" checked={draft.anchor === 'completion'} onChange={(e) => setDraft({ ...draft, anchor: e.target.checked ? 'completion' : 'schedule' })} />
            Repeat from completion date
          </label>
          <p className="text-xs text-fg-subtle">{describeRecurrence(draft)}</p>
          <div className="flex justify-between gap-2">
            {value ? (
              <Button variant="danger-ghost" size="sm" onClick={() => apply(null)}>
                Don’t repeat
              </Button>
            ) : (
              <span />
            )}
            <Button variant="primary" size="sm" onClick={() => apply(normalizeRecurrence(draft, base))}>
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ───────────── Assignee ─────────────
export function AssigneePicker({ workspaceId, listId, value, onChange, children, ...ctl }: { workspaceId: string; listId: string | null; value: string | null; onChange: (userId: string | null) => void; children: React.ReactElement } & ControlledOpen) {
  const [open, setOpen] = useOpenState(ctl);
  const people = useStoreQuery(['workspaceMembers', 'profiles', 'listMembers', 'lists'], (s) => selectAssignable(s, workspaceId, listId), [workspaceId, listId]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Assign to…" />
          <CommandList>
            <CommandEmpty>Nobody found. Share the list first.</CommandEmpty>
            {value ? (
              <CommandItem onSelect={() => (onChange(null), setOpen(false))}>
                <X /> Unassign
              </CommandItem>
            ) : null}
            <CommandGroup heading="People">
              {people.map((p) => (
                <CommandItem key={p.id} value={`${p.displayName} ${p.email ?? ''}`} onSelect={() => (onChange(p.id), setOpen(false))}>
                  <Avatar name={p.displayName} seed={p.id} size={20} />
                  <span className="truncate">{p.displayName}</span>
                  {p.id === value ? <Check className="ml-auto text-accent" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ───────────── Labels ─────────────
export function LabelPicker({ workspaceId, value, onToggle, children, ...ctl }: { workspaceId: string; value: string[]; onToggle: (labelId: string, on: boolean) => void; children: React.ReactElement } & ControlledOpen) {
  const [open, setOpen] = useOpenState(ctl);
  const { actions } = useSync();
  const labels = useStoreQuery(['labels'], (s) => selectLabels(s, workspaceId), [workspaceId]);
  const [search, setSearch] = React.useState('');
  const exact = labels.some((l) => l.name.toLowerCase() === search.trim().toLowerCase());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Find or create a label…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandGroup heading="Labels">
              {labels.map((l) => {
                const on = value.includes(l.id);
                return (
                  <CommandItem key={l.id} value={l.name} onSelect={() => onToggle(l.id, !on)}>
                    <ColorDot color={l.color} />
                    <span className="truncate">{l.name}</span>
                    {on ? <Check className="ml-auto text-accent" /> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {search.trim() && !exact ? (
              <CommandItem
                value={`create ${search}`}
                onSelect={() => {
                  const { id } = actions.createLabel(workspaceId, search.trim());
                  onToggle(id, true);
                  setSearch('');
                }}
              >
                <Tag /> Create “{search.trim()}”
              </CommandItem>
            ) : null}
            {!labels.length && !search ? <CommandEmpty>No labels yet. Type to create one.</CommandEmpty> : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function LabelColorPicker({ value, onChange }: { value: LabelColor; onChange: (c: LabelColor) => void }) {
  return (
    <div className="grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Label color">
      {LABEL_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} aria-label={c} onClick={() => onChange(c)} className={cn('grid size-7 place-items-center rounded-full', c === value && 'ring-2 ring-accent ring-offset-2 ring-offset-surface')} style={{ background: `var(--label-${c}-bg)` }}>
          <span className="size-3 rounded-full" style={{ background: `var(--label-${c}-fg)` }} />
        </button>
      ))}
    </div>
  );
}

// ───────────── Move to list ─────────────
function flatten(nodes: ListNode[], depth = 0): { id: string; title: string; emoji: string | null; depth: number }[] {
  return nodes.flatMap((n) => [{ id: n.list.id, title: n.list.title || 'Untitled list', emoji: n.list.emoji, depth }, ...flatten(n.children, depth + 1)]);
}

export function ListPicker({ workspaceId, currentListId, onPick, children, allowInbox = true, ...ctl }: { workspaceId: string; currentListId: string | null; onPick: (listId: string | null) => void; children: React.ReactElement; allowInbox?: boolean } & ControlledOpen) {
  const [open, setOpen] = useOpenState(ctl);
  const lists = useStoreQuery(['lists', 'tasks'], (s) => flatten(selectListTree(s, workspaceId)), [workspaceId]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Move to…" />
          <CommandList>
            <CommandEmpty>No lists found.</CommandEmpty>
            {allowInbox ? (
              <CommandItem value="inbox" onSelect={() => (onPick(null), setOpen(false))}>
                <Inbox /> Inbox
                {currentListId === null ? <Check className="ml-auto text-accent" /> : null}
              </CommandItem>
            ) : null}
            <CommandGroup heading="Lists">
              {lists.map((l) => (
                <CommandItem key={l.id} value={`${l.title} ${l.id}`} onSelect={() => (onPick(l.id), setOpen(false))} style={{ paddingLeft: 8 + l.depth * 14 }}>
                  {l.emoji ? <span aria-hidden>{l.emoji}</span> : <ListTodo />}
                  <span className="truncate">{l.title}</span>
                  {l.id === currentListId ? <Check className="ml-auto text-accent" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export const PickerIcons = { CalendarDays, Bell, Repeat, UserRound, Tag };
