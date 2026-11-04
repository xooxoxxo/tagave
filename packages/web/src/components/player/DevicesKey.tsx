/**
 * Where the music plays (player/devices.ts), in the player bar and in Now
 * playing:
 *
 *   the device key   an embossed icon (no circle), in the accent colour while
 *                    another device plays or this one casts; a menu of the
 *                    person's devices that are online (the one that plays
 *                    ticked, this one marked "This device"), the cast or
 *                    AirPlay picker when the browser has one, and Rename.
 *                    Picking a device moves playback there.
 *   the strip        a thin line along the top of the bar: "Playing on
 *                    Safari on iPhone" while another device plays, "Tap to
 *                    play here" when playback was handed here and the
 *                    browser waits for a tap.
 *
 * The key is there only while there is somewhere else to play: another
 * device online. With none, the cast key (CastKey) stands alone as before.
 * DevicesKeyView and DeviceStripView are driven by props (stories, tests).
 */
import { useRef, useState, type FormEvent } from 'react';
import { AirPlayIcon, Button, CastIcon, DevicesIcon, Menu, TextField, embossClassName, type EmbossPlace, type MenuItem } from '../ui';
import { Sheet } from '../ui/Sheet';
import { castLine, castProblem, chooseCastDevice, useCastStore, type CastState } from '../../player/cast';
import { choosableDevices, remoteDevice, renameDevice, transferTo, useDevicesStore } from '../../player/devices';
import { defaultDeviceName } from '../../player/deviceIdentity';
import { play, usePlayerStore } from '../../player/engine';
import { PLAYER_DEVICE_NAME_MAX } from '@tagave/shared';
import styles from './DevicesKey.module.css';

export interface DeviceChoice {
  id: string;
  name: string;
  /** this device */
  here: boolean;
  /** it plays the queue */
  playing: boolean;
}

export interface DevicesKeyViewProps {
  devices: readonly DeviceChoice[];
  /** the cast state, when this browser can cast */
  cast?: Pick<CastState, 'kind' | 'available' | 'state' | 'device' | 'reach' | 'host'> | null;
  onChoose: (id: string) => void;
  onCast?: () => void;
  onRename?: () => void;
  /** the accent colour: another device plays, or this one casts */
  lit?: boolean;
  place?: EmbossPlace;
  className?: string;
}

/** The cast row of the menu, from the cast state: the picker, the device cast to (and Stop), or why it cannot. */
function castItems(cast: DevicesKeyViewProps['cast'], onCast: (() => void) | undefined): MenuItem[] {
  if (!cast?.kind || (!cast.available && cast.state === 'off')) return [];
  const name = cast.kind === 'airplay' ? 'AirPlay' : 'Cast';
  const line = castLine(cast);
  const problem = castProblem(cast);
  const select = onCast ? { onSelect: onCast } : {};
  if (problem === 'unreachable') return [{ key: 'cast', label: name, hint: 'Not reachable', disabled: true, separated: true }];
  if (cast.kind === 'cast' && cast.state !== 'off') return [{ key: 'cast', label: 'Stop casting', ...(line ? { hint: line } : {}), ...select, separated: true }];
  return [{ key: 'cast', label: line ?? name, ...(problem === 'needs-https' ? { hint: 'Needs https' } : {}), ...(cast.state !== 'off' ? { checked: true } : {}), ...select, separated: true }];
}

export function DevicesKeyView({ devices, cast, onChoose, onCast, onRename, lit = false, place = 'page', className }: DevicesKeyViewProps) {
  const items: MenuItem[] = [
    ...devices.map((d): MenuItem => ({
      key: d.id,
      label: d.name,
      ...(d.here ? { hint: 'This device' } : {}),
      checked: d.playing,
      onSelect: () => onChoose(d.id),
    })),
    ...castItems(cast, onCast),
    ...(onRename ? [{ key: 'rename', label: 'Rename', onSelect: onRename, separated: true }] : []),
  ];
  const cls = embossClassName(place, [styles.key, lit ? styles.on : '', className].filter(Boolean).join(' '));
  return <Menu label="Devices" heading="Devices" icon={<DevicesIcon />} triggerClassName={cls} items={items} />;
}

export interface DeviceStripViewProps {
  /** the device that plays, when it is another one */
  playingOn?: string | null;
  /** playback was handed here and waits for a tap */
  needsTap?: boolean;
  onTap?: () => void;
}

/** The thin line on top of the bar. Nothing when this device plays on its own. */
export function DeviceStripView({ playingOn, needsTap = false, onTap }: DeviceStripViewProps) {
  if (needsTap) {
    return <button type="button" className={`${styles.strip} ${styles.tap}`} onClick={onTap}>Tap to play here</button>;
  }
  if (!playingOn) return null;
  return <p className={styles.strip} role="status" title={`Playing on ${playingOn}`}>Playing on {playingOn}</p>;
}

/** Whether the key belongs in the bar: another device to play on, or one plays now. */
export function useDevicesShown(): boolean {
  const s = useDevicesStore();
  const remoteId = usePlayerStore((p) => p.remoteDeviceId);
  return !!remoteId || choosableDevices(s).some((d) => d.deviceId !== s.me);
}

/** The key, connected (with the rename sheet). */
export function DevicesKey({ place, className }: { place?: EmbossPlace; className?: string }) {
  const s = useDevicesStore();
  const castState = useCastStore();
  const remoteId = usePlayerStore((p) => p.remoteDeviceId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const back = useRef<HTMLElement | null>(null);
  const active = s.active?.deviceId ?? null;
  const devices: DeviceChoice[] = choosableDevices(s).map((d) => ({
    id: d.deviceId,
    name: d.deviceId === s.me ? s.name || d.name : d.name,
    here: d.deviceId === s.me,
    playing: d.deviceId === active && (d.online || d.deviceId === s.me),
  }));
  if (!devices.some((d) => d.here)) devices.unshift({ id: s.me, name: s.name, here: true, playing: active === s.me });
  const casting = castState.state !== 'off';
  const lit = !!remoteId || casting;
  const save = (e: FormEvent) => {
    e.preventDefault();
    renameDevice(draft);
    setRenaming(false);
  };
  return (
    <>
      <DevicesKeyView
        devices={devices}
        cast={castState}
        onChoose={(id) => { void transferTo(id); }}
        onCast={chooseCastDevice}
        onRename={() => {
          back.current = globalThis.document?.activeElement as HTMLElement | null;
          setDraft(s.name);
          setRenaming(true);
        }}
        lit={lit}
        {...(place ? { place } : {})}
        {...(className ? { className } : {})}
      />
      <Sheet open={renaming} onOpenChange={setRenaming} title="Rename" returnFocus={back}>
        <form className={styles.rename} onSubmit={save}>
          <TextField label="Name" value={draft} maxLength={PLAYER_DEVICE_NAME_MAX} placeholder={defaultDeviceName()} autoFocus onChange={(e) => setDraft(e.currentTarget.value)} />
          <Button type="submit" variant="primary">Save</Button>
        </form>
      </Sheet>
    </>
  );
}

/** The strip, connected. */
export function DeviceStrip() {
  const remoteId = usePlayerStore((p) => p.remoteDeviceId);
  const needsTap = usePlayerStore((p) => p.needsTap);
  const remote = useDevicesStore((d) => (remoteId ? remoteDevice(d) : null));
  return <DeviceStripView playingOn={remoteId ? remote?.name ?? null : null} needsTap={needsTap && !remoteId} onTap={play} />;
}
