/**
 * Minimal Tauri IPC access without bundling @tauri-apps/api into the web build. Only used when
 * running inside the desktop shell (see apps/desktop/src-tauri for the commands).
 */
type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function tauri(): { invoke: Invoke } {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
  if (!internals) throw new Error('Not running in the desktop app');
  return { invoke: internals.invoke };
}
