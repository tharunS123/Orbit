'use client';

import * as React from 'react';
import { AppError, describeError } from '@orbit/shared';
import type { ActionResult } from '@orbit/sync/client';
import { toast } from '@orbit/ui';
import { playSound } from './sound';

/**
 * App-wide undo/redo for store actions. Every user action returns an ActionResult; `run` shows a
 * toast with an Undo button and pushes onto the stack so ⌘Z works too.
 */

interface UndoEntry {
  label: string;
  undo: () => void;
  redo?: () => ActionResult | void;
}

interface UndoApi {
  run: (label: string | null, fn: () => ActionResult | void, opts?: { toast?: boolean; sound?: 'complete' | null }) => ActionResult | void;
  undo: () => void;
  redo: () => void;
}

const Ctx = React.createContext<UndoApi | null>(null);

export function UndoProvider({ children }: { children: React.ReactNode }) {
  const undoStack = React.useRef<UndoEntry[]>([]);
  const redoStack = React.useRef<UndoEntry[]>([]);

  const api = React.useMemo<UndoApi>(() => {
    const run: UndoApi['run'] = (label, fn, opts = {}) => {
      let result: ActionResult | void;
      try {
        result = fn();
      } catch (error) {
        toast.error(describeError(AppError.from(error)));
        return;
      }
      if (opts.sound) playSound(opts.sound);
      if (result?.undo) {
        const entry: UndoEntry = { label: label ?? result.label ?? 'Change', undo: result.undo, redo: fn };
        undoStack.current.push(entry);
        if (undoStack.current.length > 100) undoStack.current.shift();
        redoStack.current = [];
        if (opts.toast !== false && (label ?? result.label)) {
          toast(label ?? result.label, {
            action: {
              label: 'Undo',
              onClick: () => {
                const idx = undoStack.current.lastIndexOf(entry);
                if (idx >= 0) undoStack.current.splice(idx, 1);
                entry.undo();
                redoStack.current.push(entry);
              },
            },
            duration: 5000,
          });
        }
      }
      return result;
    };
    return {
      run,
      undo: () => {
        const entry = undoStack.current.pop();
        if (!entry) return;
        try {
          entry.undo();
          redoStack.current.push(entry);
          toast(`Undid: ${entry.label}`, { duration: 2000 });
        } catch (error) {
          toast.error(describeError(AppError.from(error)));
        }
      },
      redo: () => {
        const entry = redoStack.current.pop();
        if (!entry?.redo) return;
        const res = entry.redo();
        if (res?.undo) undoStack.current.push({ ...entry, undo: res.undo });
      },
    };
  }, []);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useUndo(): UndoApi {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useUndo must be used inside UndoProvider');
  return ctx;
}
