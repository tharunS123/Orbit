'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Plus, Settings } from 'lucide-react';
import { routes, uuidv7 } from '@orbit/shared';
import { Button, Dialog, DialogContent, Field, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, cn } from '@orbit/ui';
import { useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';
import { useUndo } from '@/lib/undo';

function WorkspaceIcon({ name, icon, size = 22 }: { name: string; icon: string | null; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-md bg-accent-subtle font-semibold text-accent-subtle-fg" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden>
      {icon ?? name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { client } = useSync();
  const { setWorkspace } = useWorkspace();
  const { run } = useUndo();
  const [name, setName] = React.useState('');
  const create = () => {
    const id = uuidv7();
    run(null, () => {
      client.mutate('workspace.create', { id, memberId: uuidv7(), name: name.trim() });
    }, { toast: false });
    setWorkspace(id);
    setName('');
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Create a team workspace" description="Workspaces keep a team’s lists, labels and members together. You can invite people next." size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Workspace name" htmlFor="ws-name">
            <Input id="ws-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Design" maxLength={100} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              Create workspace
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceSwitcher({ collapsed }: { collapsed?: boolean }) {
  const { workspaces, current, setWorkspace } = useWorkspace();
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  if (!current) return null;
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className={cn('flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-bg-hover', collapsed && 'justify-center px-0')} aria-label={`Workspace: ${current.name}. Switch workspace`}>
            <WorkspaceIcon name={current.name} icon={current.icon} />
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{current.name}</span>
                <ChevronsUpDown className="size-3.5 text-fg-subtle" aria-hidden />
              </>
            )}
          </button>
        </MenuTrigger>
        <MenuContent className="w-64">
          <MenuLabel>Workspaces</MenuLabel>
          {workspaces.map((w) => (
            <MenuItem key={w.id} onSelect={() => setWorkspace(w.id)}>
              <WorkspaceIcon name={w.name} icon={w.icon} size={20} />
              <span className="truncate">{w.name}</span>
              {w.role === 'guest' ? <span className="text-[11px] text-fg-subtle">Guest</span> : null}
              {w.id === current.id ? <Check className="ml-auto !text-accent" /> : null}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => setCreating(true)}>
            <Plus /> Create workspace
          </MenuItem>
          <MenuItem onSelect={() => router.push(routes.settings('workspace'))}>
            <Settings /> Workspace settings
          </MenuItem>
        </MenuContent>
      </Menu>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
