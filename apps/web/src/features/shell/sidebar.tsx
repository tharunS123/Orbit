'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Bell,
  CalendarRange,
  ChevronRight,
  FileText,
  FolderPlus,
  Inbox,
  LayoutList,
  Mic,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Star,
  StarOff,
  Sun,
  Trash2,
  Video,
} from 'lucide-react';
import { routes, type List, type Section } from '@orbit/shared';
import { planMove } from '@orbit/core';
import { selectInbox, selectNotifications, selectSidebar, selectToday, type SidebarSection } from '@orbit/sync/client';
import { Badge, Button, ConfirmDialog, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, Tooltip, cn } from '@orbit/ui';
import { SHORTCUTS } from '@/lib/hotkeys';
import { useNow, useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';
import { SyncIndicator } from './sync-indicator';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';

function NavLink({ href, icon: Icon, label, count, active, shortcut, dot }: { href: string; icon: React.ComponentType<{ className?: string }>; label: string; count?: number; active: boolean; shortcut?: string; dot?: boolean }) {
  return (
    <Tooltip content={label} shortcut={shortcut} side="right">
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn('flex h-8 items-center gap-2.5 rounded-md px-2 text-[13.5px] transition-colors', active ? 'bg-bg-active font-medium text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg')}
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        {dot ? <span className="size-2 rounded-full bg-accent" aria-label="Unread" /> : null}
        {count ? <span className="text-xs tabular-nums text-fg-subtle">{count}</span> : null}
      </Link>
    </Tooltip>
  );
}

function ListLink({ list, active, sectionId, sections }: { list: List; active: boolean; sectionId: string | null; sections: Section[] }) {
  const { actions, client } = useSync();
  const { run } = useUndo();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: list.id, data: { kind: 'item', sectionId } });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('group/item relative', isDragging && 'z-10 opacity-60')}>
      <Link
        href={routes.list(list.id)}
        aria-current={active ? 'page' : undefined}
        className={cn('flex h-8 items-center gap-2.5 rounded-md pr-8 pl-2 text-[13.5px] transition-colors', active ? 'bg-bg-active font-medium text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg')}
        {...attributes}
        {...listeners}
      >
        <span className="grid size-4 shrink-0 place-items-center text-[13px]" aria-hidden>
          {list.emoji ?? <FileText className="size-4" />}
        </span>
        <span className="flex-1 truncate">{list.title || 'Untitled list'}</span>
      </Link>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label={`Options for ${list.title || 'Untitled list'}`} className="absolute top-1 right-1 grid size-6 place-items-center rounded-sm text-fg-subtle opacity-0 group-hover/item:opacity-100 hover:bg-bg-active focus-visible:opacity-100">
            <MoreHorizontal className="size-4" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuSub>
            <MenuSubTrigger>
              <LayoutList /> Move to section
            </MenuSubTrigger>
            <MenuSubContent>
              <MenuItem onSelect={() => client.mutate('sectionItem.move', { listId: list.id, sectionId: null, position: 'a0' })}>Starred</MenuItem>
              {sections.map((s) => (
                <MenuItem key={s.id} onSelect={() => client.mutate('sectionItem.move', { listId: list.id, sectionId: s.id, position: 'a0' })}>
                  {s.name}
                </MenuItem>
              ))}
            </MenuSubContent>
          </MenuSub>
          <MenuItem onSelect={() => run('Removed from sidebar', () => actions.unstar(list.id))}>
            <StarOff /> Unstar
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

function SectionBlock({ block, sections, activeListId }: { block: SidebarSection; sections: Section[]; activeListId: string | null }) {
  const { client } = useSync();
  const key = block.section?.id ?? 'starred';
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `drop:${key}`, data: { kind: 'section-drop', sectionId: block.section?.id ?? null } });
  const sortable = useSortable({ id: `sec:${key}`, data: { kind: 'section' }, disabled: !block.section });
  const [renaming, setRenaming] = React.useState(false);
  const [name, setName] = React.useState(block.section?.name ?? '');
  const [confirm, setConfirm] = React.useState(false);
  const collapsed = block.section?.collapsed ?? false;
  if (!block.section && !block.items.length) return null;
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }} className={cn('mt-3', sortable.isDragging && 'opacity-60')}>
      <div className="group/sec flex h-7 items-center gap-1 px-2">
        {block.section ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle hover:text-fg-muted"
            aria-expanded={!collapsed}
            onClick={() => client.mutate('section.update', { id: block.section!.id, collapsed: !collapsed })}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <ChevronRight className={cn('size-3 transition-transform', !collapsed && 'rotate-90')} aria-hidden />
            {renaming ? null : <span className="truncate">{block.section.name}</span>}
          </button>
        ) : (
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Starred</span>
        )}
        {renaming && block.section ? (
          <Input
            autoFocus
            className="h-6 text-xs"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name.trim()) client.mutate('section.update', { id: block.section!.id, name: name.trim() });
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            aria-label="Section name"
          />
        ) : null}
        {block.section ? (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={`Section options for ${block.section.name}`} className="grid size-5 place-items-center rounded-xs text-fg-subtle opacity-0 group-hover/sec:opacity-100 hover:bg-bg-active focus-visible:opacity-100">
                <MoreHorizontal className="size-3.5" />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => (setName(block.section!.name), setRenaming(true))}>
                <Pencil /> Rename
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={() => setConfirm(true)}>
                <Trash2 /> Remove section
              </MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      {!collapsed ? (
        <div ref={setDropRef} className={cn('flex min-h-2 flex-col rounded-md', isOver && 'bg-accent-subtle/40')}>
          <SortableContext items={block.items.map((i) => i.list.id)} strategy={verticalListSortingStrategy}>
            {block.items.map(({ list }) => (
              <ListLink key={list.id} list={list} active={activeListId === list.id} sectionId={block.section?.id ?? null} sections={sections} />
            ))}
          </SortableContext>
          {block.section && !block.items.length ? <p className="px-2 py-1 text-xs text-fg-subtle">Drag starred lists here</p> : null}
        </div>
      ) : null}
      {block.section ? (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Remove “${block.section.name}”?`}
          description="The section is removed from your sidebar. Its lists stay starred and are not deleted."
          confirmLabel="Remove section"
          onConfirm={() => {
            client.mutate('section.delete', { id: block.section!.id });
          }}
        />
      ) : null}
    </div>
  );
}

export function Sidebar({ onCollapse, onNewTask, onTalk }: { onCollapse: () => void; onNewTask: () => void; onTalk?: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { userId, timeZone, actions, client, store } = useSync();
  const { workspaceId } = useWorkspace();
  const { run } = useUndo();
  const now = useNow();
  const ctx = { userId, timeZone, now, workspaceId: null };
  const counts = useStoreQuery(
    ['tasks', 'taskUserStates', 'lists', 'notifications'],
    (s) => {
      const today = selectToday(s, ctx);
      return {
        inbox: selectInbox(s, ctx).open.length,
        today: today.overdue.length + today.today.length + today.laterToday.length,
        unread: selectNotifications(s, userId).unread,
      };
    },
    [now.getMinutes(), userId],
  );
  const sidebar = useStoreQuery(['sections', 'sectionItems', 'lists'], (s) => (workspaceId ? selectSidebar(s, userId, workspaceId) : []), [workspaceId, userId]);
  const sections = sidebar.map((b) => b.section).filter((s): s is Section => Boolean(s));
  const activeListId = pathname === '/list' ? params.get('id') : null;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || !workspaceId) return;
    const activeKind = active.data.current?.kind;
    if (activeKind === 'section') {
      const ids = sections.map((s) => s.id);
      const from = String(active.id).slice(4);
      const to = ids.indexOf(String(over.id).replace(/^sec:|^drop:/, ''));
      if (to < 0 || from === ids[to]) return;
      const updates = planMove(sections, [from], to);
      for (const u of updates) client.mutate('section.update', { id: u.id, position: u.position });
      return;
    }
    const listId = String(active.id);
    const overData = over.data.current as { kind?: string; sectionId?: string | null } | undefined;
    const targetSection = overData?.kind === 'section-drop' ? (overData.sectionId ?? null) : overData?.kind === 'item' ? (overData.sectionId ?? null) : undefined;
    if (targetSection === undefined) return;
    const block = sidebar.find((b) => (b.section?.id ?? null) === targetSection);
    const items = (block?.items ?? []).map((i) => ({ id: i.list.id, position: i.item.position }));
    const others = items.filter((i) => i.id !== listId);
    const overIndex = others.findIndex((i) => i.id === String(over.id));
    const toIndex = overIndex >= 0 ? overIndex : others.length;
    const updates = planMove([...others, { id: listId, position: 'zz' }], [listId], toIndex);
    const mine = updates.find((u) => u.id === listId);
    if (mine) client.mutate('sectionItem.move', { listId, sectionId: targetSection, position: mine.position });
    for (const u of updates.filter((x) => x.id !== listId)) client.mutate('sectionItem.move', { listId: u.id, sectionId: targetSection, position: u.position });
  };

  const newList = () => {
    if (!workspaceId) return;
    const res = run(null, () => actions.createList({ workspaceId, title: '' }), { toast: false }) as { id: string } | undefined;
    if (res?.id) router.push(`${routes.list(res.id)}&new=1`);
  };

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 bg-bg-subtle px-2.5 pt-2.5 pb-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <WorkspaceSwitcher />
        </div>
        <Tooltip content="Collapse sidebar" shortcut={SHORTCUTS.toggleSidebar}>
          <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Collapse sidebar">
            <PanelLeftClose />
          </Button>
        </Tooltip>
      </div>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('orbit:palette'))}
        className="mt-1 flex h-8 items-center gap-2.5 rounded-md border border-border bg-surface px-2 text-[13px] text-fg-subtle shadow-xs hover:text-fg-muted"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1 text-left">Search</span>
        <span className="text-[11px]">⌘K</span>
      </button>
      <div className="mt-2 flex flex-col gap-0.5">
        <NavLink href={routes.inbox()} icon={Inbox} label="Inbox" count={counts.inbox} active={pathname === '/inbox'} shortcut={SHORTCUTS.inbox} />
        <NavLink href={routes.today()} icon={Sun} label="Today" count={counts.today} active={pathname === '/today'} shortcut={SHORTCUTS.today} />
        <NavLink href={routes.upcoming()} icon={CalendarRange} label="Upcoming" active={pathname === '/upcoming'} shortcut={SHORTCUTS.upcoming} />
        <NavLink href={routes.meetings()} icon={Video} label="Meetings" active={pathname.startsWith('/meeting')} shortcut={SHORTCUTS.meetings} />
        <NavLink href={routes.updates()} icon={Bell} label="Updates" active={pathname === '/updates'} dot={counts.unread > 0} shortcut={SHORTCUTS.updates} />
        <NavLink href={routes.lists()} icon={LayoutList} label="All lists" active={pathname === '/lists'} />
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sidebar.filter((b) => b.section).map((b) => `sec:${b.section!.id}`)} strategy={verticalListSortingStrategy}>
            {sidebar.map((block) => (
              <SectionBlock key={block.section?.id ?? 'starred'} block={block} sections={sections} activeListId={activeListId} />
            ))}
          </SortableContext>
        </DndContext>
        {sidebar.every((b) => !b.items.length) ? (
          <p className="mt-4 px-2 text-xs leading-relaxed text-fg-subtle">
            <Star className="mr-1 inline size-3" aria-hidden />
            Star lists to pin them here.
          </p>
        ) : null}
        <div className="mt-3 flex flex-col gap-0.5">
          <button type="button" onClick={newList} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-fg-muted hover:bg-bg-hover hover:text-fg">
            <Plus className="size-4" aria-hidden /> New list
          </button>
          <button
            type="button"
            onClick={() => workspaceId && actions.createSection(workspaceId, 'New section')}
            className="flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <FolderPlus className="size-4" aria-hidden /> New section
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <div className="flex gap-1">
          <Button variant="primary" size="sm" className="flex-1" onClick={onNewTask}>
            <Plus /> New task
          </Button>
          {onTalk ? (
            <Tooltip content="Talk — add tasks by voice" shortcut={SHORTCUTS.talk}>
              <Button variant="secondary" size="sm" onClick={onTalk} aria-label="Talk">
                <Mic />
              </Button>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-1">
          <UserMenu />
          <SyncIndicator compact />
        </div>
      </div>
      {counts.unread > 0 ? <Badge className="sr-only">{counts.unread} unread updates</Badge> : null}
      <span className="sr-only">{store.pendingMutations().length} changes pending</span>
    </nav>
  );
}
