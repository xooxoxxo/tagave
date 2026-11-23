/**
 * Settings › Modules › Integrations (owner), under the Modules list: one
 * group, anchored at `#integrations` (Collection's Connect Discogs lands
 * here). The Contact saves with its own Save and sends nothing else; the
 * Discogs token and the AcoustID key are secrets with their own Set /
 * Replace / Forget, never part of a Save; Fingerprinting saves when
 * changed and waits for an AcoustID key. Link Discogs IDs is an action.
 * The Discogs attribution stays in view, as Discogs's API terms ask.
 * IntegrationsView is the page alone, driven by props (stories, tests);
 * SettingsProvidersPage connects it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LibrarySettingsView } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings, useEnrichSweep } from '../hooks/useLibrary';
import { useFingerprintStats, type FingerprintStats } from '../hooks/useFingerprint';
import { Button, Input, SaveStatus, askFirst, SegmentedControl, SettingsGroup, SettingsRow, SettingsSave, useSaveFlash, useSettingsDraft, type SaveState } from '../components/ui';
import { SecretRow } from '../components/settings/SecretRow';
import styles from './SettingsProvidersPage.module.css';

export type IntegrationSecret = 'discogsToken' | 'acoustidKey';

/** A save's progress and outcome. */
export interface IntegrationSave {
  pending?: boolean;
  state?: SaveState;
  detail?: string | null;
}

export interface IntegrationsViewProps {
  settings: Pick<LibrarySettingsView, 'contactString' | 'discogsTokenSet' | 'discogsTokenHint' | 'acoustidKeySet' | 'acoustidKeyHint' | 'fingerprintingEnabled'>;
  /** the Contact's draft */
  contact: string;
  onContact: (value: string) => void;
  onSaveContact: (body: { contactString: string }) => void;
  contactStatus?: IntegrationSave;
  secrets?: Partial<Record<IntegrationSecret, IntegrationSave>>;
  onSetSecret: (key: IntegrationSecret, value: string) => void;
  onForgetSecret: (key: IntegrationSecret) => void;
  onFingerprinting: (on: boolean) => void;
  fingerprintStatus?: IntegrationSave;
  stats?: FingerprintStats | null;
  linking?: { pending?: boolean; queued?: boolean; error?: string | null };
  onLinkDiscogs: () => void;
}

const ON_OFF = (disabled: boolean) => [{ value: 'off' as const, label: 'Off', disabled }, { value: 'on' as const, label: 'On', disabled }];

/** "1,204 of 1,300 looked up · 87 with candidates · …" */
export function lookupsValue(s: FingerprintStats): string {
  const n = (x: number) => x.toLocaleString();
  const queued = s.queue.fingerprintWaiting + s.queue.lookupWaiting;
  return [
    `${n(s.albums.lookedUp)} of ${n(s.albums.lookedUp + s.albums.remaining)} looked up`,
    `${n(s.albums.withCandidates)} with candidates`,
    s.albums.matchedViaAcoustid > 0 ? `${n(s.albums.matchedViaAcoustid)} matched` : null,
    `${n(s.files.fingerprinted)} files${s.files.failed ? ` (${s.files.failed} failed)` : ''}`,
    queued > 0 ? `${queued} queued` : null,
  ].filter(Boolean).join(' · ');
}

/** "Paused until 14:05: rate limited", the key's kind named when it is a user key. */
export function pausedValue(p: NonNullable<FingerprintStats['provider']>): string {
  const until = new Date(p.parkedUntil).toLocaleTimeString();
  const key = /invalid api key/i.test(p.reason ?? '') ? '. Use an application key, not a user key' : '';
  return `Paused until ${until}${p.reason ? `: ${p.reason}` : ''}${key}`;
}

export interface ContactRowProps {
  /** the stored contact */
  stored: string | null;
  /** the draft */
  contact: string;
  onContact: (value: string) => void;
  onSaveContact: (body: { contactString: string }) => void;
  status?: IntegrationSave | undefined;
}

/** The Contact and its own Save (Integrations, the setup checklist). */
export function ContactRow({ stored, contact, onContact, onSaveContact, status = {} }: ContactRowProps) {
  const typed = contact.trim();
  // the API needs three characters and cannot clear the contact
  const dirty = typed.length >= 3 && typed !== (stored ?? '');
  return (
    <SettingsRow as="div" label="Contact" help="Sent with requests to MusicBrainz and Discogs, which ask for a way to reach you">
      <span className={styles.control}>
        <Input
          dense
          className={styles.field}
          aria-label="Contact"
          placeholder="you@example.com"
          autoComplete="email"
          value={contact}
          onChange={(e) => onContact(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && dirty) { e.preventDefault(); onSaveContact({ contactString: typed }); } }}
        />
        <SettingsSave dirty={dirty} pending={!!status.pending} state={status.state ?? null} detail={status.detail ?? null} onSave={() => onSaveContact({ contactString: typed })} />
      </span>
    </SettingsRow>
  );
}

export interface IntegrationSecretRowProps {
  /** one is stored, and the last characters the server tells */
  set: boolean;
  hint: string | null | undefined;
  status?: IntegrationSave | undefined;
  onSet: (value: string) => void;
  onForget: () => void;
}

/** The Discogs token's secret row (Integrations, the setup checklist). */
export function DiscogsTokenRow({ set, hint, status, onSet, onForget }: IntegrationSecretRowProps) {
  return (
    <SecretRow
      label="Discogs token"
      help={<a href="https://www.discogs.com/settings/developers" target="_blank" rel="noreferrer">Get a token</a>}
      set={set}
      hint={hint}
      placeholder="Discogs API token"
      minLength={10}
      pending={status?.pending}
      state={status?.state}
      detail={status?.detail}
      onSet={onSet}
      onForget={onForget}
    />
  );
}

/** The AcoustID key's secret row (Integrations, the setup checklist). */
export function AcoustidKeyRow({ set, hint, status, onSet, onForget }: IntegrationSecretRowProps) {
  return (
    <SecretRow
      label="AcoustID key"
      help={<a href="https://acoustid.org/new-application" target="_blank" rel="noreferrer">Get a key</a>}
      set={set}
      hint={hint}
      placeholder="AcoustID application key"
      minLength={8}
      pending={status?.pending}
      state={status?.state}
      detail={status?.detail}
      onSet={onSet}
      onForget={onForget}
    />
  );
}

/** The Integrations group alone (no hooks: stories and tests render it, a test calls its Save). */
export function IntegrationsView({
  settings, contact, onContact, onSaveContact, contactStatus = {}, secrets = {}, onSetSecret, onForgetSecret,
  onFingerprinting, fingerprintStatus = {}, stats = null, linking = {}, onLinkDiscogs,
}: IntegrationsViewProps) {
  const keySet = settings.acoustidKeySet;
  return (
    <SettingsGroup
      id="integrations"
      title="Integrations"
      status={<SaveStatus state={fingerprintStatus.state ?? null} detail={fingerprintStatus.detail ?? null} />}
      after={<p className={styles.attribution}>tagave uses the Discogs API but is not affiliated with, sponsored or endorsed by Discogs. Discogs is a trademark of Zink Media, LLC.</p>}
    >
      <ContactRow stored={settings.contactString} contact={contact} onContact={onContact} onSaveContact={onSaveContact} status={contactStatus} />
      <DiscogsTokenRow set={settings.discogsTokenSet} hint={settings.discogsTokenHint} status={secrets.discogsToken} onSet={(v) => onSetSecret('discogsToken', v)} onForget={() => onForgetSecret('discogsToken')} />
      <AcoustidKeyRow set={keySet} hint={settings.acoustidKeyHint} status={secrets.acoustidKey} onSet={(v) => onSetSecret('acoustidKey', v)} onForget={() => onForgetSecret('acoustidKey')} />
      <SettingsRow
        as="div"
        label="Fingerprinting"
        help="Fingerprint unidentified albums and look them up on AcoustID"
        value={keySet ? null : <span className={styles.valueOff}>Needs an AcoustID key</span>}
      >
        <SegmentedControl
          label="Fingerprinting"
          value={settings.fingerprintingEnabled ? 'on' : 'off'}
          onChange={(v) => { if (keySet && !fingerprintStatus.pending) onFingerprinting(v === 'on'); }}
          options={ON_OFF(!keySet || !!fingerprintStatus.pending)}
        />
      </SettingsRow>
      {stats && <SettingsRow as="div" label="Lookups" value={<span className={styles.value}>{lookupsValue(stats)}</span>} />}
      {stats?.provider && <SettingsRow as="div" label="AcoustID" value={<span className={styles.danger} role="alert">{pausedValue(stats.provider)}</span>} />}
      <SettingsRow as="div" label="Discogs IDs">
        <span className={styles.control}>
          {linking.queued && <span className={styles.value} role="status">Queued</span>}
          {linking.error && <span className={styles.danger} role="alert">{linking.error}</span>}
          <Button size="sm" variant="secondary" loading={!!linking.pending} onClick={onLinkDiscogs}>Link Discogs IDs</Button>
        </span>
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * The group's empty shell while the settings load, so `#integrations` is in
 * the page from the first render and a link landing on it has somewhere to go.
 */
export function IntegrationsPending() {
  return <SettingsGroup id="integrations" title="Integrations" />;
}

const problem = (err: unknown, fallback: string) => {
  const e = err as { detail?: string; title?: string; message?: string } | null;
  return e?.detail || e?.title || e?.message || fallback;
};

/** Forget a key only once the owner says so. */
export function askForgetSecret(key: IntegrationSecret): Promise<boolean> {
  return key === 'discogsToken' ? askFirst('forgetDiscogsToken') : askFirst('forgetAcoustidKey');
}

/** One save's progress and its `✓ Saved` / `Not saved`. */
export function useSave() {
  const flash = useSaveFlash();
  const [pending, setPending] = useState(false);
  const go = async (fn: () => Promise<unknown>): Promise<boolean> => {
    flash.clear();
    setPending(true);
    try {
      await fn();
      flash.saved();
      return true;
    } catch (err) {
      flash.failed(problem(err, ''));
      return false;
    } finally {
      setPending(false);
    }
  };
  const status: IntegrationSave = { pending, state: flash.state, detail: flash.detail };
  return { status, go };
}

export function SettingsProvidersPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: settings } = useLibrarySettings(libraryId);
  const update = useUpdateLibrarySettings(libraryId);
  const { data: stats } = useFingerprintStats(libraryId, !!settings?.acoustidKeySet);
  const enrichSweep = useEnrichSweep(libraryId);
  const base = useMemo(() => (settings ? { contactString: settings.contactString ?? '' } : null), [settings]);
  const { draft, set } = useSettingsDraft(base);
  const contact = useSave();
  const discogs = useSave();
  const acoustid = useSave();
  const fingerprint = useSave();
  const secretSave = { discogsToken: discogs, acoustidKey: acoustid };

  // a link to #integrations lands before the settings arrive: once they
  // do and the group has grown, bring it into view again (one time)
  const landed = useRef(false);
  const ready = !!settings && !!draft;
  useEffect(() => {
    if (!ready || landed.current) return;
    landed.current = true;
    if (window.location.hash === '#integrations') document.getElementById('integrations')?.scrollIntoView?.();
  }, [ready]);

  // the anchor only until the settings arrive
  if (!settings || !draft) return <IntegrationsPending />;

  return (
    <IntegrationsView
      settings={settings}
      contact={draft.contactString}
      onContact={(v) => set({ contactString: v })}
      onSaveContact={(body) => void contact.go(() => update.mutateAsync(body))}
      contactStatus={contact.status}
      secrets={{ discogsToken: discogs.status, acoustidKey: acoustid.status }}
      onSetSecret={(key, value) => void secretSave[key].go(() => update.mutateAsync({ [key]: value }))}
      onForgetSecret={(key) => void (async () => { if (await askForgetSecret(key)) await secretSave[key].go(() => update.mutateAsync({ [key]: null })); })()}
      onFingerprinting={(on) => void fingerprint.go(() => update.mutateAsync({ fingerprintingEnabled: on }))}
      fingerprintStatus={fingerprint.status}
      stats={stats ?? null}
      linking={{ pending: enrichSweep.isPending, queued: enrichSweep.isSuccess, error: enrichSweep.isError ? problem(enrichSweep.error, 'Not queued') : null }}
      onLinkDiscogs={() => enrichSweep.mutate()}
    />
  );
}
