/**
 * The cast key, in the player bar and in Now playing: an embossed icon (no
 * circle), AirPlay's on Safari, the cast icon elsewhere. It is there only
 * while a device is (or while casting), and shows the accent colour while
 * casting.
 *
 *   a device around         opens the platform's picker (which also stops)
 *   casting with the SDK    a menu: the device, Stop casting
 *   PUBLIC_URL unreachable  a menu that says so (labels and values only):
 *                           "Not reachable" (localhost, or unset) or
 *                           "Needs https" (a Chromecast and plain http),
 *                           with the address; the second still offers
 *                           the picker
 *
 * CastKeyView is driven by props (stories, tests); CastKey connects it to
 * player/cast.ts.
 */
import { AirPlayIcon, CastIcon, EmbossIconButton, Menu, embossClassName, type EmbossPlace, type MenuItem } from '../ui';
import { castLine, castProblem, chooseCastDevice, useCastStore, type CastState } from '../../player/cast';
import styles from './CastKey.module.css';

export interface CastKeyViewProps extends Pick<CastState, 'kind' | 'available' | 'state' | 'device' | 'reach' | 'host'> {
  onChoose: () => void;
  place?: EmbossPlace;
  className?: string;
}

export function CastKeyView({ kind, available, state, device, reach, host, onChoose, place = 'page', className }: CastKeyViewProps) {
  if (!kind || (!available && state === 'off')) return null;
  const casting = state !== 'off';
  const icon = kind === 'airplay' ? <AirPlayIcon /> : <CastIcon />;
  const name = kind === 'airplay' ? 'AirPlay' : 'Cast';
  const line = castLine({ state, device, kind });
  const cls = embossClassName(place, [styles.key, casting ? styles.on : '', className].filter(Boolean).join(' '));
  const problem = castProblem({ reach, kind, state });
  if (problem) {
    const items: MenuItem[] = [
      { key: 'reach', label: problem === 'unreachable' ? 'Not reachable' : 'Needs https', hint: host ?? 'PUBLIC_URL', disabled: true },
      ...(problem === 'needs-https' ? [{ key: 'choose', label: 'Choose a device', onSelect: onChoose, separated: true }] : []),
    ];
    return <Menu label={name} heading={name} icon={icon} triggerClassName={cls} items={items} />;
  }
  if (kind === 'cast' && casting) {
    return <Menu label={line ?? name} heading={line ?? name} icon={icon} triggerClassName={cls} items={[{ key: 'stop', label: 'Stop casting', onSelect: onChoose }]} />;
  }
  return (
    <EmbossIconButton label={line ?? name} place={place} className={[styles.key, casting ? styles.on : '', className].filter(Boolean).join(' ')} data-casting={casting ? '' : undefined} onClick={onChoose}>
      {icon}
    </EmbossIconButton>
  );
}

/** The key, connected. */
export function CastKey({ place, className }: { place?: EmbossPlace; className?: string }) {
  const s = useCastStore();
  return <CastKeyView {...s} onChoose={chooseCastDevice} {...(place ? { place } : {})} {...(className ? { className } : {})} />;
}
