/**
 * The release track a plan file was paired with, as its row shows it:
 * "1 · Clouds · 98%". The disc joins the position only on a release with
 * more than one medium ("2-3"). No percentage when the track came by
 * position alone (no link, so no distance).
 */
import { LOW_MATCH_CONFIDENCE, matchConfidence, type TagPlanItem } from '@tagave/shared';

export interface Pairing {
  position: string;
  title: string;
  /** percent, absent without a link distance */
  confidence?: number;
  low: boolean;
  text: string;
}

export function pairingOf(item: Pick<TagPlanItem, 'releaseTrack' | 'matchDistance'>): Pairing | null {
  const t = item.releaseTrack;
  if (!t) return null;
  const pos = t.position === null ? '' : t.media > 1 && t.mediumNo !== null ? `${t.mediumNo}-${t.position}` : String(t.position);
  const confidence = item.matchDistance === undefined ? undefined : matchConfidence(item.matchDistance);
  const parts = [pos, t.title, confidence === undefined ? '' : `${confidence}%`].filter(Boolean);
  return {
    position: pos,
    title: t.title,
    ...(confidence === undefined ? {} : { confidence }),
    low: confidence !== undefined && confidence < LOW_MATCH_CONFIDENCE,
    text: parts.join(' · '),
  };
}
