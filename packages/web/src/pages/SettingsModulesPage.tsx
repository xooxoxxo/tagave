/**
 * Settings › Modules (owner): the optional parts of tagave, from the signed
 * catalogue of the release this server runs. With the updater each one has
 * Turn on / Turn off (after a step-up) and the run shows step by step like
 * an update; without it, each shows the install-tagave.sh command instead.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { moduleCommand, type ModuleRun, type ModuleStatus, type ModulesView, type StepUpMethod } from '@tagave/shared';
import { Badge, Banner, Button, confirmDialog, type BadgeTone } from '../components/ui';
import { StepList, RunLog, clock, sentence, useNow } from '../components/InAppUpdate';
import { StepUpDialog } from '../components/StepUpDialog';
import { useModuleAction, useModules, modulesKey } from '../hooks/useModules';
import { getStepUp } from '../services/stepUp';
import runStyles from '../components/InAppUpdate.module.css';
import styles from './SettingsModulesPage.module.css';

const DISMISSED_KEY = 'tagave-module-run-dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(id: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, id);
  } catch {
    /* private window: the run stays on screen */
  }
}

const STATE: Record<ModuleStatus['state'], { tone: BadgeTone; label: string }> = {
  off: { tone: 'neutral', label: 'Off' },
  installing: { tone: 'info', label: 'Turning on' },
  removing: { tone: 'info', label: 'Turning off' },
  on: { tone: 'success', label: 'On' },
  failed: { tone: 'danger', label: 'Failed' },
  update_pending: { tone: 'warning', label: 'Update pending' },
};

function size(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** The run of a module, on top of the list until dismissed. */
export function ModuleRunView({ run, disconnected, onDismiss }: { run: ModuleRun; disconnected: boolean; onDismiss: () => void }) {
  const running = run.status === 'running';
  const now = useNow(running);
  const elapsed = (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt);
  const current = run.steps.find((s) => s.status === 'running');
  const on = run.action === 'enable';
  let head: { tone: 'info' | 'ok' | 'warn' | 'error'; title: string; body?: string };
  switch (run.status) {
    case 'running':
      head = { tone: 'info', title: `${on ? 'Turning on' : 'Turning off'} ${run.moduleName}`, body: current ? `${current.label}…` : 'Starting…' };
      break;
    case 'succeeded':
      head = run.reason
        ? { tone: 'warn', title: `${run.moduleName} is ${on ? 'on' : 'off'}`, body: sentence(run.reason) }
        : { tone: 'ok', title: `${run.moduleName} is ${on ? 'on' : 'off'}`, body: on ? 'It runs and reports healthy.' : run.deleteData ? (run.deleteHistory ? 'Its data and the listens it recorded are deleted.' : 'Its data is deleted.') : 'Its data is kept.' };
      break;
    case 'failed':
      head = { tone: 'warn', title: `${run.moduleName} was not turned ${on ? 'on' : 'off'}`, body: sentence(run.reason) };
      break;
    case 'rolled_back':
      head = { tone: 'warn', title: `Turning ${on ? 'on' : 'off'} ${run.moduleName} failed; everything is as it was`, body: sentence(run.reason) };
      break;
    default:
      head = { tone: 'error', title: `Turning ${on ? 'on' : 'off'} ${run.moduleName} failed, and so did the roll back`, body: sentence(run.reason) };
  }
  return (
    <div className={runStyles.run} aria-live="polite">
      <div className={`${runStyles.runHead} ${runStyles[`tone-${head.tone}`]}`}>
        <div>
          <p className={runStyles.runTitle}>
            {running && <span className={runStyles.spinner} aria-hidden="true" />}
            {head.title}
          </p>
          {head.body && <p className={runStyles.runBody}>{head.body}</p>}
        </div>
        <span className={runStyles.elapsed} title="Elapsed">{clock(elapsed)}</span>
      </div>
      {disconnected && running && <p className={runStyles.note}>tagave is restarting with the new settings. This page reconnects on its own.</p>}
      <StepList run={run} />
      <RunLog log={run.log} />
      {!running && (
        <div className={runStyles.row}>
          <Button size="sm" variant="secondary" onClick={onDismiss}>Done</Button>
        </div>
      )}
    </div>
  );
}

export interface TurnOffChoice { deleteData: boolean; deleteHistory: boolean }

/**
 * What Turn off keeps and what the boxes delete. For a module with rows in
 * tagave's database (the player), the catalogue says plainly what goes and
 * what stays, and offers its history (the player's listens) as a second box,
 * unticked.
 */
export function TurnOffChoices({ m, onChange, initial }: { m: ModuleStatus; onChange: (c: TurnOffChoice) => void; initial?: TurnOffChoice }) {
  const [data, setData] = useState(initial?.deleteData ?? false);
  const [history, setHistory] = useState(initial?.deleteHistory ?? false);
  const appData = m.appData ?? null;
  const set = (d: boolean, h: boolean) => {
    setData(d);
    setHistory(h);
    onChange({ deleteData: d, deleteHistory: d && h });
  };
  return (
    <>
      <p>Its containers stop and its settings come out of the configuration. Kept unless you tick the box: {m.keepsOnRemoval}.</p>
      <label className={styles.check}>
        <input type="checkbox" checked={data} onChange={(e) => set(e.target.checked, history)} />
        <span>Also delete its data. This cannot be undone.</span>
      </label>
      {data && appData && (
        <div className={styles.choice}>
          <p className={styles.consequence}>{appData.removes}{!history && appData.keeps ? ` ${appData.keeps}` : ''}</p>
          {appData.history && (
            <label className={styles.check}>
              <input type="checkbox" checked={history} onChange={(e) => set(true, e.target.checked)} />
              <span>{appData.history}</span>
            </label>
          )}
        </div>
      )}
    </>
  );
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.command}>
      <code>{command}</code>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => undefined);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export interface SettingsModulesViewProps {
  view: ModulesView;
  /** The last refresh failed (the app restarts during some runs). */
  disconnected?: boolean;
  /** Which module has a request on its way. */
  pending?: string | null;
  error?: string | null;
  dismissed?: string | null;
  onTurnOn: (m: ModuleStatus) => void;
  onTurnOff: (m: ModuleStatus) => void;
  onDismiss: (runId: string) => void;
}

export function SettingsModulesView({ view, disconnected = false, pending = null, error = null, dismissed = null, onTurnOn, onTurnOff, onDismiss }: SettingsModulesViewProps) {
  const run = view.run;
  const busy = run?.status === 'running';
  const command = view.mode === 'command';
  return (
    <div className={styles.page}>
      {view.mode === 'unreachable' && <Banner tone="danger">The updater does not answer, so modules cannot be turned on or off from here. {sentence(view.error)}</Banner>}
      {command && (
        <p className={styles.hint}>
          This server has no in-app updater, so modules are turned on and off in the install folder, with the commands below. To use the buttons instead, add the updater: <code>./install-tagave.sh enable-updater</code>.
        </p>
      )}
      {!view.verified && view.mode !== 'unreachable' && (
        <Banner tone="warning">No module can be turned on: {sentence(view.problem) || 'the signed catalogue of this release is not here.'}</Banner>
      )}
      {run && run.id !== dismissed && <ModuleRunView run={run} disconnected={disconnected} onDismiss={() => onDismiss(run.id)} />}
      {view.modules.length > 0 && (
        <ul className={styles.list}>
          {view.modules.map((m) => {
            const state = STATE[m.state];
            const isOn = m.state === 'on' || m.state === 'update_pending';
            const moving = m.state === 'installing' || m.state === 'removing';
            return (
              <li key={m.id} className={styles.item}>
                <div className={styles.head}>
                  <h3 className={styles.name}>{m.name}</h3>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </div>
                <p className={styles.purpose}>{m.purpose}</p>
                <p className={styles.meta}>
                  Memory up to {size(m.estimate.memoryMb)} · about {size(m.estimate.diskMb)} on disk{m.roles.includes('app') ? '' : ' · one-computer installs only'}
                </p>
                {m.state === 'failed' && m.lastError && <p className={styles.error}>{sentence(m.lastError)}</p>}
                {m.state === 'update_pending' && <p className={styles.meta}>This release pins another image for it; the next update (or Turn off and on) brings it in.</p>}
                {!m.available && m.reason && <p className={styles.meta}>{m.reason}</p>}
                {command ? (
                  m.available && <CommandLine command={moduleCommand(isOn ? 'disable' : 'enable', m.id)} />
                ) : (
                  view.mode === 'updater' && view.verified && (
                    <div className={styles.actions}>
                      {isOn ? (
                        <Button size="sm" variant="secondary" disabled={busy || moving} loading={pending === m.id} onClick={() => onTurnOff(m)}>Turn off</Button>
                      ) : (
                        <Button size="sm" disabled={busy || moving || !m.available} loading={pending === m.id || m.state === 'installing'} onClick={() => onTurnOn(m)}>
                          {m.state === 'failed' ? 'Try again' : 'Turn on'}
                        </Button>
                      )}
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <p className={styles.footnote}>Only modules from tagave&rsquo;s signed release catalogue can be installed; their images are pulled by digest and checked first.</p>
    </div>
  );
}

export function SettingsModulesContent() {
  const modules = useModules();
  const action = useModuleAction();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ m: ModuleStatus; act: 'enable' | 'disable'; choice: TurnOffChoice; methods: StepUpMethod[] } | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // A run that finished may have changed what the app offers (the player).
  const finished = modules.data?.run && modules.data.run.status !== 'running' ? modules.data.run.id : null;
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries({ queryKey: ['player'] });
  }, [finished, queryClient]);

  const go = async (m: ModuleStatus, act: 'enable' | 'disable', choice: TurnOffChoice) => {
    setError(null);
    setPending(m.id);
    try {
      await action.mutateAsync({ id: m.id, action: act, ...choice });
      setDismissed(null);
    } catch (err) {
      const e = err as { status?: number; title?: string; detail?: string };
      if (e.status === 403 && e.title === 'Step-up required') {
        const s = await getStepUp();
        setStepUp({ m, act, choice, methods: s.methods });
      } else {
        setError(sentence(e.detail ?? e.title) || `${m.name} could not be turned ${act === 'enable' ? 'on' : 'off'}.`);
      }
    } finally {
      setPending(null);
    }
  };

  const withStepUp = async (m: ModuleStatus, act: 'enable' | 'disable', choice: TurnOffChoice) => {
    try {
      const s = await getStepUp();
      if (!s.fresh) {
        setStepUp({ m, act, choice, methods: s.methods });
        return;
      }
    } catch {
      /* the server decides anyway */
    }
    await go(m, act, choice);
  };

  const turnOn = async (m: ModuleStatus) => {
    const ok = await confirmDialog({
      title: `Turn on ${m.name}?`,
      message: (
        <>
          <p>{m.purpose}</p>
          <p>The updater downloads its images (checked against the signed release), adds its settings and starts it. It takes up to {size(m.estimate.memoryMb)} of memory. If it does not come up healthy, everything goes back as it was.</p>
        </>
      ),
      confirmLabel: 'Turn on',
    });
    if (ok) await withStepUp(m, 'enable', { deleteData: false, deleteHistory: false });
  };

  const turnOff = async (m: ModuleStatus) => {
    let choice: TurnOffChoice = { deleteData: false, deleteHistory: false };
    const ok = await confirmDialog({
      title: `Turn off ${m.name}?`,
      message: <TurnOffChoices m={m} onChange={(c) => { choice = c; }} />,
      confirmLabel: 'Turn off',
      tone: 'danger',
    });
    if (ok) await withStepUp(m, 'disable', choice);
  };

  if (modules.isLoading) return <p className={styles.hint}>Loading the modules…</p>;
  if (!modules.data) return <Banner tone="danger">Could not load the modules. {sentence((modules.error as { detail?: string } | null)?.detail)}</Banner>;
  return (
    <>
      <SettingsModulesView
        view={modules.data}
        disconnected={modules.isError}
        pending={pending}
        error={error}
        dismissed={dismissed}
        onTurnOn={(m) => void turnOn(m)}
        onTurnOff={(m) => void turnOff(m)}
        onDismiss={(id) => { writeDismissed(id); setDismissed(id); void queryClient.invalidateQueries({ queryKey: modulesKey }); }}
      />
      {stepUp && (
        <StepUpDialog
          action={`Turning ${stepUp.act === 'enable' ? 'on' : 'off'} ${stepUp.m.name}`}
          methods={stepUp.methods}
          onCancel={() => setStepUp(null)}
          onDone={() => { const s = stepUp; setStepUp(null); void go(s.m, s.act, s.choice); }}
        />
      )}
    </>
  );
}
