'use client';

import * as React from 'react';
import { AlertTriangle, Monitor, RotateCcw } from 'lucide-react';
import { PRODUCT, acceleratorFromKeyEvent, acceleratorText, defaultQuickCaptureShortcut, describeAccelerator, formatAccelerator, normalizeAccelerator, validateAccelerator } from '@orbit/shared';
import { Button, Kbd, Skeleton, Switch, cn, toast, useKeyboardOS } from '@orbit/ui';
import { desktop, isDesktop, useQuickCaptureConfig, type QuickCaptureConfig, type QuickCapturePatch } from '@/lib/desktop';
import { inAppCombos } from '@/lib/shortcuts';
import { SettingRow, SettingsSection } from './common';

function Keycaps({ accelerator }: { accelerator: string }) {
  const os = useKeyboardOS();
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={describeAccelerator(accelerator, os)}>
      {formatAccelerator(accelerator, os).map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </span>
  );
}

/**
 * Click, then press the new combination. Esc cancels. The current global shortcut is released
 * while recording so pressing it records it instead of opening Quick Capture.
 */
function ShortcutRecorder({ value, disabled, onRecord }: { value: string; disabled?: boolean; onRecord: (accelerator: string) => Promise<void> }) {
  const os = useKeyboardOS();
  const [recording, setRecording] = React.useState(false);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);

  const stop = React.useCallback(() => {
    setRecording(false);
    setPreview(null);
    void desktop.pauseQuickCapture(false).catch(() => undefined);
  }, []);
  React.useEffect(() => () => void desktop.pauseQuickCapture(false).catch(() => undefined), []);

  const start = () => {
    setProblem(null);
    setRecording(true);
    void desktop.pauseQuickCapture(true).catch(() => undefined);
  };

  const onKeyDown = async (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return stop();
    if (e.key === 'Tab') return stop();
    const rec = acceleratorFromKeyEvent(e.nativeEvent);
    if (rec.state === 'modifiers-only') {
      setPreview(rec.modifiers.length ? rec.modifiers.map((m) => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Super' })[m]).join('+') + '+…' : null);
      return;
    }
    if (rec.state === 'unsupported') {
      setProblem(`“${rec.key}” can’t be used in a global shortcut.`);
      return;
    }
    const check = validateAccelerator(rec.accelerator, os, { inAppCombos: inAppCombos(os) });
    if (!check.ok) {
      setProblem(check.message);
      return;
    }
    setSaving(true);
    try {
      await onRecord(check.accelerator);
      setProblem(null);
      stop();
    } catch (err) {
      setProblem((err as Error).message);
      stop();
    } finally {
      setSaving(false);
      ref.current?.focus();
    }
  };

  const problemId = React.useId();
  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        ref={ref}
        type="button"
        disabled={disabled || saving}
        onClick={() => (recording ? stop() : start())}
        onKeyDown={(e) => void onKeyDown(e)}
        onBlur={() => recording && stop()}
        aria-describedby={problem ? problemId : undefined}
        aria-label={recording ? 'Recording shortcut. Press the new key combination, or Escape to cancel.' : `Change shortcut, currently ${describeAccelerator(value, os)}`}
        className={cn(
          'inline-flex h-9 min-w-40 items-center justify-center gap-2 rounded-md border px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-50',
          recording ? 'border-accent bg-accent-subtle text-accent-subtle-fg' : 'border-border bg-surface hover:bg-bg-hover',
        )}
      >
        {recording ? <span className="animate-pulse">{preview ?? 'Press keys…'}</span> : <Keycaps accelerator={value} />}
      </button>
      {problem ? (
        <p id={problemId} role="alert" className="max-w-72 text-right text-xs text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function QuickCaptureDesktop({ config, setConfig }: { config: QuickCaptureConfig; setConfig: (c: QuickCaptureConfig) => void }) {
  const os = useKeyboardOS();
  const update = async (patch: QuickCapturePatch) => {
    const next = await desktop.updateQuickCapture(patch);
    setConfig(next);
    return next;
  };
  const isDefault = normalizeAccelerator(config.shortcut, os) === normalizeAccelerator(config.defaultShortcut, os);
  return (
    <SettingsSection title="Quick Capture" description={`Add a task from any app without switching to ${PRODUCT.name}. The window opens on top of whatever you’re doing; Enter saves, Esc closes.`}>
      <SettingRow label="Global shortcut" description={config.enabled ? 'Works while Orbit is running, even when its window is closed.' : 'Turned off — the shortcut is released for other apps.'}>
        <Switch
          checked={config.enabled}
          onCheckedChange={(enabled) => void update({ enabled }).catch((e: Error) => toast.error(e.message))}
          aria-label="Enable global Quick Capture shortcut"
        />
      </SettingRow>
      <SettingRow label="Shortcut" description="Click, then press the keys you want to use.">
        <ShortcutRecorder
          value={config.shortcut}
          disabled={!config.enabled}
          onRecord={async (shortcut) => {
            const next = await update({ shortcut });
            toast.success(`Quick Capture is now ${acceleratorText(next.shortcut, os)}`);
          }}
        />
      </SettingRow>
      <SettingRow label="Reset to default" description={`Default: ${acceleratorText(config.defaultShortcut, os)}`}>
        <Button
          variant="secondary"
          size="sm"
          disabled={isDefault && config.registered}
          onClick={() =>
            void desktop
              .resetQuickCapture()
              .then((next) => {
                setConfig(next);
                if (next.error) toast.error(next.error);
                else toast.success('Quick Capture shortcut reset');
              })
              .catch((e: Error) => toast.error(e.message))
          }
        >
          <RotateCcw /> Reset
        </Button>
      </SettingRow>
      <SettingRow label="Hide when focus is lost" description="Close the capture window when you click into another app. Your draft is kept for a few minutes.">
        <Switch checked={config.hideOnBlur} onCheckedChange={(hideOnBlur) => void update({ hideOnBlur }).catch((e: Error) => toast.error(e.message))} aria-label="Hide Quick Capture when focus is lost" />
      </SettingRow>
      {config.enabled && config.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-warning-subtle px-3 py-2 text-sm text-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> {config.error}
        </p>
      ) : null}
    </SettingsSection>
  );
}

export function DesktopSettings() {
  const os = useKeyboardOS();
  const [config, setConfig] = useQuickCaptureConfig();
  if (!isDesktop()) {
    return (
      <SettingsSection title="Quick Capture" description="Capture a task from any app with a global keyboard shortcut.">
        <div className="flex items-start gap-3 rounded-lg bg-bg-hover/60 p-4 text-sm">
          <Monitor className="mt-0.5 size-5 shrink-0 text-fg-subtle" aria-hidden />
          <div className="flex flex-col gap-1">
            <p>
              Available in the {PRODUCT.name} desktop app for macOS and Windows. The default shortcut is <Keycaps accelerator={defaultQuickCaptureShortcut(os)} />, and you can change it here once the app is installed.
            </p>
            <p className="text-fg-muted">In the browser, press <Kbd>Q</Kbd> or <Kbd>N</Kbd> to add a task.</p>
          </div>
        </div>
      </SettingsSection>
    );
  }
  if (!config) {
    return (
      <SettingsSection title="Quick Capture">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </SettingsSection>
    );
  }
  return <QuickCaptureDesktop config={config} setConfig={setConfig} />;
}
