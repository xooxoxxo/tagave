/**
 * Settings › Modules: one row per module (name, On/Off, a chevron), each
 * opening Settings › Modules › <module>, where everything that module needs
 * lives: its Off/On (owner), its connection, its per-person settings, and
 * Turn off's "Also delete its data".
 *
 * The player and any module the signed catalogue adds are switched by the
 * updater (Turn on / Turn off after a step-up, the run step by step like an
 * update; without the updater the install-tagave.sh command). Music
 * Connections, Listen elsewhere, Playlists, Lidarr and Similar artists are settings in
 * tagave's database. Everyone sees the modules that have something for them
 * (the player's Listening, Listen elsewhere's platforms, their Music
 * Connections); the owner sees all of them and their switches.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { can, moduleCommand, type ModuleRun, type ModuleStatus, type ModulesView, type StepUpMethod } from '@tagave/shared';
import { Banner, Button, ChevronRightIcon, SegmentedControl, confirmDialog, updateConfirm } from '../components/ui';
import { StepList, RunLog, clock, sentence, useNow } from '../components/InAppUpdate';
import { StepUpDialog } from '../components/StepUpDialog';
import { useStepUpAction } from '../components/users/useStepUpAction';
import { LidarrSettings } from '../components/LidarrSettings';
import { NotAvailable } from '../components/access/NotAvailable';
import { useModuleAction, useModules, modulesKey } from '../hooks/useModules';
import { useFacets } from '../hooks/useFacets';
import { useCapabilities } from '../hooks/usePlayer';
import { useRole } from '../hooks/usePermissions';
import { useMcModule, useRemoveMcData, useSetMcModule } from '../hooks/useMcModule';
import { useListenLinksModule, useRemoveListenLinksData, useSetListenLinksModule } from '../hooks/useListenLinks';
import { useLidarrSettings, useRemoveLidarrData, useSetLidarrModule } from '../hooks/useLidarr';
import { useRemoveSimilarArtistsData, useSetSimilarArtistsModule, useSimilarArtistsModule } from '../hooks/useSimilarArtists';
import { docsUrl } from '../utils/docs';
import { allPlaylistsExportUrl, download, usePlaylistsModule, useRemovePlaylistsData, useSetPlaylistsModule } from '../hooks/usePlaylists';
import { getStepUp } from '../services/stepUp';
import { MODULE_PAGES, moduleSlug, type ModulePageEntry } from './moduleSettings';
import { SettingsConnectionsContent } from './SettingsConnectionsPage';
import { SettingsListenElsewhereContent } from './SettingsListenElsewherePage';
import { SettingsPlaybackContent } from './SettingsPlaybackPage';
import { SettingsListeningContent } from './SettingsListeningPage';
import { SettingsDjContent } from './SettingsDjPage';
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

const STATE_LABEL: Record<ModuleStatus['state'], string> = {
  off: 'Off',
  installing: 'Turning on',
  removing: 'Turning off',
  on: 'On',
  failed: 'Failed',
  update_pending: 'Update pending',
};

const isOn = (m: ModuleStatus) => m.state === 'on' || m.state === 'update_pending';

function size(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/* ---------- the list ---------- */

export interface ModuleRowView {
  slug: string;
  name: string;
  /** On, Off, Turning on, Failed, … */
  state: string;
  on: boolean;
}

/** Settings › Modules: name, state and a chevron per module; each row opens its page. */
export function ModulesListView({ rows, notice = null }: { rows: ModuleRowView[]; notice?: ReactNode }) {
  return (
    <div className={styles.page}>
      {notice}
      {rows.length > 0 && (
        <ul className={styles.rows} aria-label="Modules">
          {rows.map((r) => (
            <li key={r.slug}>
              <Link to="/settings/modules/$module" params={{ module: r.slug }} className={styles.row}>
                <span className={styles.rowName}>{r.name}</span>
                <span className={styles.rowState} data-on={r.on || undefined}>{r.state}</span>
                <span className={styles.chevron} aria-hidden="true"><ChevronRightIcon /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The rows this person sees. The owner: every module, the player's state
 * from the catalogue when the updater answers. Anyone else: the modules
 * that are on and have something of theirs (the player's Listening, Listen
 * elsewhere, Music Connections). Null while it is not known yet.
 */
export function moduleRows(input: {
  owner: boolean;
  /** manifest id → on, from GET /facets */
  enabled: Record<string, boolean> | null;
  catalogue?: ModulesView | null;
  /** a player server answers to tagave (the bundled one or the owner's own) */
  playerInstalled?: boolean | null;
}): ModuleRowView[] | null {
  const { owner, enabled, catalogue = null, playerInstalled = null } = input;
  if (!enabled) return null;
  const listed = catalogue?.modules ?? [];
  const extra: ModulePageEntry[] = listed.filter((m) => !MODULE_PAGES.some((p) => p.id === m.id)).map((m) => ({ slug: m.id, id: m.id, name: m.name }));
  const rows: ModuleRowView[] = [];
  for (const page of [...MODULE_PAGES, ...extra]) {
    const fromCatalogue = listed.find((m) => m.id === page.id);
    if (owner) {
      if (fromCatalogue) rows.push({ slug: page.slug, name: fromCatalogue.name, state: STATE_LABEL[fromCatalogue.state], on: isOn(fromCatalogue) });
      else if (page.id in enabled) rows.push({ slug: page.slug, name: page.name, state: enabled[page.id] ? 'On' : 'Off', on: !!enabled[page.id] });
      continue;
    }
    const mine = page.id === 'player' ? playerInstalled === true : (page.id === 'listen-links' || page.id === 'mc' || page.id === 'dj') && enabled[page.id] === true;
    if (mine) rows.push({ slug: page.slug, name: page.name, state: 'On', on: true });
  }
  return rows;
}

/** The rows for the signed-in person, and whether any are known yet. */
export function useModuleRows(): ModuleRowView[] | null {
  const owner = can(useRole(), 'system.manage');
  const facets = useFacets();
  const catalogue = useModules(owner);
  const caps = useCapabilities();
  const enabled = facets.data ? Object.fromEntries(facets.data.modules.filter((m) => !m.builtIn).map((m) => [m.id, m.enabled])) : null;
  return moduleRows({ owner, enabled, catalogue: catalogue.data ?? null, playerInstalled: caps.data ? !!caps.data.player?.installed : null });
}

export function SettingsModulesContent() {
  const owner = can(useRole(), 'system.manage');
  const rows = useModuleRows();
  const catalogue = useModules(owner);
  const view = catalogue.data;
  const notice = owner && view
    ? view.mode === 'unreachable'
      ? <Banner tone="danger">Updater not answering. {sentence(view.error)}</Banner>
      : !view.verified && view.modules.length === 0
        ? <Banner tone="warning">Catalogue not verified. {sentence(view.problem)}</Banner>
        : null
    : null;
  if (!rows) return <p className={styles.hint}>Loading…</p>;
  return <ModulesListView rows={rows} notice={notice} />;
}

/* ---------- one control shape: Off | On ---------- */

const ON_OFF = (disabled: boolean) => [{ value: 'off' as const, label: 'Off', disabled }, { value: 'on' as const, label: 'On', disabled }];

/** A choice inside a dialog: its label, then Off | On (never a checkbox). */
export function OffOnField({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel} aria-hidden="true">{label}</span>
      <SegmentedControl label={label} value={on ? 'on' : 'off'} onChange={(v) => onChange(v === 'on')} options={ON_OFF(false)} />
    </div>
  );
}

/** One labels-and-values line: Kept · its requests. */
function ValueLine({ label, value }: { label: string; value: ReactNode }) {
  return <p className={styles.value}><span className={styles.valueLabel}>{label}</span> · {value}</p>;
}

/** Turn off's confirm key: deleting the data is the danger key, and says so. */
export function turnOffKey(deleteData: boolean): { confirmLabel: string; tone: 'primary' | 'danger' } {
  return deleteData ? { confirmLabel: 'Turn off and delete', tone: 'danger' } : { confirmLabel: 'Turn off', tone: 'primary' };
}

export interface ModuleSwitchViewProps {
  /** the module's name: the control's name for screen readers */
  name: string;
  /** a visible label above the control (Lidarr: Get missing albums) */
  label?: string | undefined;
  on: boolean;
  disabled?: boolean;
  /** values under the control: memory and disk, what it holds */
  meta?: ReactNode;
  error?: string | null;
  onSwitch: (on: boolean) => void;
}

export function ModuleSwitchView({ name, label, on, disabled = false, meta = null, error = null, onSwitch }: ModuleSwitchViewProps) {
  return (
    <div className={styles.switch}>
      {label && <span className={styles.switchLabel} aria-hidden="true">{label}</span>}
      <SegmentedControl label={label ?? name} value={on ? 'on' : 'off'} onChange={(v) => { if (!disabled) onSwitch(v === 'on'); }} options={ON_OFF(disabled)} />
      {meta && <p className={styles.meta}>{meta}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

/* ---------- catalogue modules (the updater switches them) ---------- */

/** The run of a module, on its page until dismissed. */
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
      {disconnected && running && <p className={runStyles.note}>Restarting…</p>}
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
 * Turn off's choices for a catalogue module: what it keeps, and Delete its
 * data as Off | On (Off first). For a module with rows in tagave's database
 * (the player), On says what goes and what stays, and offers its history
 * (the player's listens) as a second Off | On.
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
      {data && appData
        ? <p className={styles.consequence}>{appData.removes}{!history && appData.keeps ? ` ${appData.keeps}` : ''}</p>
        : <ValueLine label={data ? 'Deleted' : 'Kept'} value={m.keepsOnRemoval} />}
      <OffOnField label="Delete its data" on={data} onChange={(d) => set(d, history)} />
      {data && appData?.history && <OffOnField label="Delete its listens" on={history} onChange={(h) => set(true, h)} />}
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

export interface CatalogueModuleViewProps {
  view: ModulesView;
  /** the module's id in the catalogue */
  id: string;
  name: string;
  /** The last refresh failed (the app restarts during some runs). */
  disconnected?: boolean;
  pending?: boolean;
  error?: string | null;
  dismissed?: string | null;
  onSwitch: (m: ModuleStatus, on: boolean) => void;
  onDismiss: (runId: string) => void;
}

/**
 * A catalogue module's Off | On with what the updater says about it: its
 * memory and disk, a state between Off and On, why it can't run here, and
 * without the updater the command to run in the install folder.
 */
export function CatalogueModuleView({ view, id, name, disconnected = false, pending = false, error = null, dismissed = null, onSwitch, onDismiss }: CatalogueModuleViewProps) {
  const m = view.modules.find((x) => x.id === id);
  const run = view.run && view.run.module === id && view.run.id !== dismissed ? view.run : null;
  const busy = view.run?.status === 'running';
  if (view.mode === 'unreachable') return <Banner tone="danger">Updater not answering. {sentence(view.error)}</Banner>;
  if (!m) return <Banner tone="warning">Catalogue not verified. {sentence(view.problem)}</Banner>;
  const moving = m.state === 'installing' || m.state === 'removing';
  const command = view.mode === 'command';
  const canSwitch = view.mode === 'updater' && view.verified && m.available && !busy && !moving && !pending;
  const meta = [
    `${size(m.estimate.memoryMb)} memory · ${size(m.estimate.diskMb)} disk${m.roles.includes('app') ? '' : ' · one-computer installs'}`,
    m.state !== 'on' && m.state !== 'off' ? STATE_LABEL[m.state] : null,
  ].filter(Boolean).join(' · ');
  return (
    <>
      {run && <ModuleRunView run={run} disconnected={disconnected} onDismiss={() => onDismiss(run.id)} />}
      <ModuleSwitchView name={name} on={isOn(m)} disabled={!canSwitch} meta={meta} error={error} onSwitch={(on) => onSwitch(m, on)} />
      {m.state === 'failed' && m.lastError && <p className={styles.error}>{sentence(m.lastError)}</p>}
      {!m.available && m.reason && <p className={styles.meta}>{m.reason}</p>}
      {command && m.available && <CommandLine command={moduleCommand(isOn(m) ? 'disable' : 'enable', m.id)} />}
    </>
  );
}

function CatalogueSwitch({ id, name }: { id: string; name: string }) {
  const modules = useModules();
  const action = useModuleAction();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ m: ModuleStatus; act: 'enable' | 'disable'; choice: TurnOffChoice; methods: StepUpMethod[]; oidcName?: string | null } | null>(null);
  const [pending, setPending] = useState(false);

  // A run that finished may have changed what the app offers (the player).
  const finished = modules.data?.run && modules.data.run.status !== 'running' ? modules.data.run.id : null;
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries({ queryKey: ['player'] });
  }, [finished, queryClient]);

  const go = async (m: ModuleStatus, act: 'enable' | 'disable', choice: TurnOffChoice) => {
    setError(null);
    setPending(true);
    try {
      await action.mutateAsync({ id: m.id, action: act, ...choice });
      setDismissed(null);
    } catch (err) {
      const e = err as { status?: number; title?: string; detail?: string };
      if (e.status === 403 && e.title === 'Step-up required') {
        const s = await getStepUp();
        setStepUp({ m, act, choice, methods: s.methods, oidcName: s.oidcName ?? null });
      } else {
        setError(sentence(e.detail ?? e.title) || `${m.name} could not be turned ${act === 'enable' ? 'on' : 'off'}.`);
      }
    } finally {
      setPending(false);
    }
  };

  const withStepUp = async (m: ModuleStatus, act: 'enable' | 'disable', choice: TurnOffChoice) => {
    try {
      const s = await getStepUp();
      if (!s.fresh) {
        setStepUp({ m, act, choice, methods: s.methods, oidcName: s.oidcName ?? null });
        return;
      }
    } catch {
      /* the server decides anyway */
    }
    await go(m, act, choice);
  };

  const onSwitch = async (m: ModuleStatus, on: boolean) => {
    if (on) {
      const ok = await confirmDialog({
        title: `Turn on ${m.name}?`,
        message: (
          <>
            <p>{m.purpose}</p>
            <p>Uses up to {size(m.estimate.memoryMb)} of memory.</p>
          </>
        ),
        confirmLabel: 'Turn on',
      });
      if (ok) await withStepUp(m, 'enable', { deleteData: false, deleteHistory: false });
      return;
    }
    let choice: TurnOffChoice = { deleteData: false, deleteHistory: false };
    const ok = await confirmDialog({
      title: `Turn off ${m.name}?`,
      message: <TurnOffChoices m={m} onChange={(c) => { choice = c; updateConfirm(turnOffKey(c.deleteData)); }} />,
      ...turnOffKey(false),
    });
    if (ok) await withStepUp(m, 'disable', choice);
  };

  if (modules.isLoading) return <p className={styles.hint}>Loading…</p>;
  if (!modules.data) return <Banner tone="danger">Modules not loaded. {sentence((modules.error as { detail?: string } | null)?.detail)}</Banner>;
  return (
    <>
      <CatalogueModuleView
        view={modules.data}
        id={id}
        name={name}
        disconnected={modules.isError}
        pending={pending}
        error={error}
        dismissed={dismissed}
        onSwitch={(m, on) => void onSwitch(m, on)}
        onDismiss={(runId) => { writeDismissed(runId); setDismissed(runId); void queryClient.invalidateQueries({ queryKey: modulesKey }); }}
      />
      {stepUp && (
        <StepUpDialog
          action={`Turning ${stepUp.act === 'enable' ? 'on' : 'off'} ${stepUp.m.name}`}
          methods={stepUp.methods}
          oidcName={stepUp.oidcName}
          onCancel={() => setStepUp(null)}
          onDone={() => { const s = stepUp; setStepUp(null); void go(s.m, s.act, s.choice); }}
        />
      )}
    </>
  );
}

/* ---------- modules switched by a setting in tagave's database ---------- */

export interface OffChoice { deleteData: boolean; keepFills: boolean }

export interface SettingOffChoicesProps {
  /** what Turn off keeps (Kept · …), and what Delete its data deletes */
  kept: string;
  /** the lines while Delete its data is On; Deleted · `kept` by default */
  deleted?: (choice: OffChoice) => Array<[label: string, value: string]>;
  /** above the choices (Playlists: Export first) */
  before?: ReactNode;
  /** offer Keep filled IDs while deleting (Music Connections) */
  keepFills?: boolean;
  initial?: OffChoice;
  onChange: (choice: OffChoice) => void;
}

/** Turn off's choices for a module that is a setting: labels, values and Off | On. */
export function SettingOffChoices({ kept, deleted, before = null, keepFills = false, initial, onChange }: SettingOffChoicesProps) {
  const [choice, setChoice] = useState<OffChoice>(initial ?? { deleteData: false, keepFills: false });
  const set = (next: OffChoice) => {
    setChoice(next);
    onChange(next);
  };
  const lines: Array<[string, string]> = choice.deleteData ? (deleted?.(choice) ?? [['Deleted', kept]]) : [['Kept', kept]];
  return (
    <>
      {lines.map(([label, value]) => <ValueLine key={label} label={label} value={value} />)}
      {before}
      <OffOnField label="Delete its data" on={choice.deleteData} onChange={(d) => set({ ...choice, deleteData: d })} />
      {keepFills && choice.deleteData && <OffOnField label="Keep filled IDs" on={choice.keepFills} onChange={(k) => set({ ...choice, keepFills: k })} />}
    </>
  );
}

interface SettingSwitchProps extends Pick<SettingOffChoicesProps, 'kept' | 'deleted' | 'before' | 'keepFills'> {
  name: string;
  label?: string;
  on: boolean;
  meta: string | null;
  pending: boolean;
  setOn: (on: boolean) => Promise<unknown>;
  removeData: (choice: OffChoice) => Promise<unknown>;
}

/** Off | On for a module that is a setting; Off asks first and can delete its data (the API turns it off then). */
function SettingSwitch({ name, label, on, meta, pending, kept, deleted, before = null, keepFills = false, setOn, removeData }: SettingSwitchProps) {
  const { run, dialog } = useStepUpAction();
  const [error, setError] = useState<string | null>(null);
  const act = async (verb: string, fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await run(`${verb} ${name}`, fn);
    } catch (err) {
      const e = err as { detail?: string; title?: string } | null;
      setError(sentence(e?.detail ?? e?.title) || `${name} could not be changed.`);
    }
  };
  const onSwitch = async (next: boolean) => {
    if (next) return act('Turning on', () => setOn(true));
    let choice: OffChoice = { deleteData: false, keepFills: false };
    const ok = await confirmDialog({
      title: `Turn off ${name}?`,
      message: (
        <SettingOffChoices
          kept={kept}
          {...(deleted ? { deleted } : {})}
          before={before}
          keepFills={keepFills}
          onChange={(c) => { choice = c; updateConfirm(turnOffKey(c.deleteData)); }}
        />
      ),
      ...turnOffKey(false),
    });
    if (ok) await act('Turning off', () => (choice.deleteData ? removeData(choice) : setOn(false)));
  };
  return (
    <>
      <ModuleSwitchView name={name} label={label} on={on} disabled={pending} meta={meta} error={error} onSwitch={(v) => void onSwitch(v)} />
      {dialog}
    </>
  );
}

/** Music Connections' lines while Delete its data is On. */
export const mcDeleted = (c: OffChoice): Array<[string, string]> => [
  ['Deleted', c.keepFills ? 'connections, items' : 'connections, items, filled IDs'],
  ['Revoked', 'every connection'],
  ...(c.keepFills ? [['Kept', 'filled IDs'] as [string, string]] : []),
];

function McSwitch() {
  const mc = useMcModule();
  const setOn = useSetMcModule();
  const remove = useRemoveMcData();
  if (!mc.data) return null;
  const v = mc.data;
  return (
    <SettingSwitch
      name="Music Connections"
      on={v.enabled}
      meta={`${plural(v.links, 'connection', 'connections')} · ${v.landed} items${v.fills > 0 ? ` · ${v.fills} IDs filled in` : ''}`}
      pending={setOn.isPending || remove.isPending}
      kept="connections, items, filled IDs"
      deleted={mcDeleted}
      keepFills
      setOn={(on) => setOn.mutateAsync(on)}
      removeData={(c) => remove.mutateAsync(c.keepFills)}
    />
  );
}

function ListenSwitch() {
  const mod = useListenLinksModule();
  const setOn = useSetListenLinksModule();
  const remove = useRemoveListenLinksData();
  if (!mod.data) return null;
  const v = mod.data;
  return (
    <SettingSwitch
      name="Listen elsewhere"
      on={v.enabled}
      meta={`${plural(v.albums, 'album', 'albums')} · ${plural(v.artists, 'artist', 'artists')} · ${plural(v.people, 'person', 'people')}`}
      pending={setOn.isPending || remove.isPending}
      kept="links, everyone’s platforms"
      setOn={(on) => setOn.mutateAsync(on)}
      removeData={() => remove.mutateAsync()}
    />
  );
}

function PlaylistsSwitch() {
  const mod = usePlaylistsModule();
  const setOn = useSetPlaylistsModule();
  const remove = useRemovePlaylistsData();
  if (!mod.data) return null;
  const v = mod.data;
  return (
    <SettingSwitch
      name="Playlists"
      on={v.enabled}
      meta={`${plural(v.playlists, 'playlist', 'playlists')} · ${plural(v.people, 'person', 'people')}`}
      pending={setOn.isPending || remove.isPending}
      kept="everyone’s playlists"
      before={<p><Button size="sm" variant="secondary" onClick={() => download(allPlaylistsExportUrl)}>Export first</Button></p>}
      setOn={(on) => setOn.mutateAsync(on)}
      removeData={() => remove.mutateAsync()}
    />
  );
}

function LidarrSwitch() {
  const mod = useLidarrSettings();
  const setOn = useSetLidarrModule();
  const remove = useRemoveLidarrData();
  if (!mod.data) return null;
  const v = mod.data;
  return (
    <SettingSwitch
      name="Lidarr"
      label="Get missing albums"
      on={v.enabled}
      meta={`${v.open} getting`}
      pending={setOn.isPending || remove.isPending}
      kept="requests"
      setOn={(on) => setOn.mutateAsync(on)}
      removeData={() => remove.mutateAsync()}
    />
  );
}

function SimilarSwitch() {
  const mod = useSimilarArtistsModule();
  const setOn = useSetSimilarArtistsModule();
  const remove = useRemoveSimilarArtistsData();
  if (!mod.data) return null;
  const v = mod.data;
  return (
    <>
      <SettingSwitch
        name="Similar artists"
        on={v.enabled}
        meta={`${plural(v.artists, 'artist', 'artists')} · ${v.lastfm ? 'ListenBrainz, Last.fm' : 'ListenBrainz'}`}
        pending={setOn.isPending || remove.isPending}
        kept="similar-artist lists"
        setOn={(on) => setOn.mutateAsync(on)}
        removeData={() => remove.mutateAsync()}
      />
      <p className={styles.meta}><a href={docsUrl('install.md#similar-artists')} target="_blank" rel="noreferrer">What it sends</a></p>
    </>
  );
}

/* ---------- Settings › Modules › <module> ---------- */

/** A module that is off, for someone who can't turn it on: the value alone. */
function OffValue() {
  return <p className={styles.offValue}>Off</p>;
}

/**
 * One module's page: its Off | On (owner), then everything it needs. Each
 * part keeps the permission it had on its old page: the player's server,
 * scan, scrobbling key and quality are the owner's (old Playback); its
 * Listening is everyone's; Listen elsewhere and Music Connections are each
 * person's own; Lidarr and Playlists are the owner's alone.
 */
export function SettingsModuleContent({ slug }: { slug: string }) {
  const owner = can(useRole(), 'system.manage');
  const facets = useFacets();
  const caps = useCapabilities();
  const catalogue = useModules(owner);
  const known = MODULE_PAGES.find((p) => p.slug === slug);
  const extra = !known ? catalogue.data?.modules.find((m) => moduleSlug(m.id) === slug) : undefined;
  const entry: ModulePageEntry | undefined = known ?? (extra ? { slug, id: extra.id, name: extra.name } : undefined);
  if (!entry) {
    if (owner && catalogue.isLoading) return null;
    return <NotAvailable inline />;
  }
  const on = facets.data?.modules.find((m) => m.id === entry.id)?.enabled ?? null;
  const heading = <h2>{entry.name}</h2>;

  switch (entry.id) {
    case 'player': {
      const installed = caps.data ? !!caps.data.player?.installed : null;
      if (!owner) {
        return <>{heading}{installed === false ? <OffValue /> : installed && <SettingsListeningContent heading={false} />}</>;
      }
      return (
        <>
          {heading}
          <CatalogueSwitch id="player" name="Player" />
          <SettingsPlaybackContent />
          {/* each person's own part, once a player server answers (Not set up says it already) */}
          {installed && <><h2 className={styles.part}>Listening</h2><SettingsListeningContent heading={false} /></>}
        </>
      );
    }
    case 'lidarr':
      if (!owner) return <NotAvailable inline />;
      return <>{heading}<LidarrSwitch /><LidarrSettings /></>;
    case 'listen-links':
      return <>{heading}{owner && <ListenSwitch />}{on === false ? (owner ? null : <OffValue />) : on && <SettingsListenElsewhereContent heading={false} />}</>;
    case 'mc':
      return <>{heading}{owner && <McSwitch />}{on === false ? (owner ? null : <OffValue />) : on && <SettingsConnectionsContent heading={false} />}</>;
    case 'playlists':
      if (!owner) return <NotAvailable inline />;
      return <>{heading}<PlaylistsSwitch /></>;
    case 'similar-artists':
      if (!owner) return <NotAvailable inline />;
      return <>{heading}<SimilarSwitch /></>;
    case 'dj':
      // each person's Simple mode, while the module is on (its Off | On is the owner's, from the module's own switch)
      return <>{heading}{on === false ? <OffValue /> : on && <SettingsDjContent />}</>;
    default:
      if (!owner) return <NotAvailable inline />;
      return <>{heading}<CatalogueSwitch id={entry.id} name={entry.name} /></>;
  }
}
