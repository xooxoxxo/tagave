/**
 * Plain names for background jobs. The worker records its internal job type
 * ("tags.preview"); Background activity shows these instead.
 */
const JOB_TYPE_LABEL: Record<string, string> = {
  'artists.resolve': 'Artist lookup',
  'collection.sync': 'Collection sync',
  'enrich.sweep': 'Discogs and MusicBrainz linking',
  'gaps.recompute': 'Missing albums check',
  'identify.sweep': 'Album identification',
  'queue.autoaccept': 'Auto-accept matches',
  'scan.dir': 'Folder scan',
  'scan.root': 'Library scan',
  'tags.preview': 'Tag plan preview',
  'tags.apply': 'Tag plan apply',
  'tags.revert': 'Tag plan revert',
  'worker.heartbeat': 'Worker check-in',
};

/** A job type the page does not know yet reads as words, never as a dotted id. */
export function jobTypeLabel(type: string): string {
  const known = JOB_TYPE_LABEL[type];
  if (known) return known;
  const words = type.replace(/[._]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Background job';
}

const JOB_STATE_LABEL: Record<string, string> = {
  created: 'Queued',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function jobStateLabel(state: string): string {
  return JOB_STATE_LABEL[state] ?? (state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Unknown');
}
