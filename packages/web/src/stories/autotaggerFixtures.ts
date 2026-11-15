/**
 * Library care › Autotagger and Settings › Modules › Autotagger, as the api
 * answers them: a run of 1,812 albums (p99 1,204 · p97 233 · p95 121 · p90
 * 88 · no pick 166), its bands against the gate, a spot check, the accept
 * preview, two batches (one undone, with albums left as they were), the
 * local model, a payload preview and the match provenance of a model, a
 * rule and a hand match. Invented albums and people.
 */
import type {
  AcceptPreview, AgreementView, AutotaggerLibraryView, AutotaggerModuleView, BandRow, BatchDetail, BatchSummary, LocalModelView, LocalModelsView,
  PayloadPreview, RunView, SpotCheckItem,
} from '@tagave/shared';
import { DEFAULT_AUTOTAGGER_CONFIG } from '@tagave/shared';

export const LIBRARY_LOCAL: AutotaggerLibraryView = {
  enabled: true,
  keySet: false,
  keyHint: null,
  config: { ...DEFAULT_AUTOTAGGER_CONFIG },
  spentThisMonth: 0,
  spentOther: [],
  currency: 'USD',
};

export const LIBRARY_JEV: AutotaggerLibraryView = {
  ...LIBRARY_LOCAL,
  keySet: true,
  keyHint: '9f2c',
  config: { ...DEFAULT_AUTOTAGGER_CONFIG, decider: 'jev', monthlyCap: 20, payloadSeenAt: '2026-11-09T21:30:00Z', payloadSeenBy: 'Ada' },
  spentThisMonth: 4.2,
};

export const LIBRARY_NO_KEY: AutotaggerLibraryView = { ...LIBRARY_JEV, keySet: false, keyHint: null, config: { ...LIBRARY_JEV.config, decider: 'jev' } };
export const LIBRARY_NOT_SEEN: AutotaggerLibraryView = { ...LIBRARY_JEV, config: { ...LIBRARY_JEV.config, payloadSeenAt: null, payloadSeenBy: null } };

const band = (b: string, min: number, decided: number, coverage: number, errorRate: number | null, errorUpper: number) =>
  ({ band: b, min, decided, coverage, wrongRelease: 0, wrongAlbum: 0, errorRate, errorUpper });

const model = (id: string, version: string, createdAt: string, active: boolean, albums: number): LocalModelView => ({
  id, version, createdAt, active,
  counts: { albums, rows: albums * 6, owner: Math.round(albums * 0.62), auto: Math.round(albums * 0.38), rejections: 214 },
  metrics: {
    albums, groupedAlbums: albums - 40, folds: 5, seed: 7, cutoff: 0.9, margin: 0.05,
    bands: [band('p99', 0.99, 1104, 0.58, 0.002, 0.006), band('p97', 0.97, 382, 0.2, 0.008, 0.019), band('p95', 0.95, 151, 0.08, 0.02, 0.046), band('p90', 0.9, 93, 0.05, 0.04, 0.09)],
    atOrAbove: [],
    undecided: 182,
    topPickRight: { right: albums - 27, albums, rate: (albums - 27) / albums },
  },
});

export const MODELS: LocalModelsView = (() => {
  const models = [
    model('m3', 'local-2026-11-14', '2026-11-14T08:10:00Z', true, 1912),
    model('m2', 'local-2026-11-02', '2026-11-02T08:10:00Z', false, 1640),
    model('m1', 'local-2026-10-20', '2026-10-20T08:10:00Z', false, 1288),
  ];
  return { active: models[0]!, models };
})();

export const NO_MODELS: LocalModelsView = { active: null, models: [] };

export const RUN_DONE: RunView = {
  id: 'run-1',
  deciderId: 'local',
  population: 'needs_review',
  state: 'done',
  pauseReason: null,
  message: null,
  modelLabel: 'Local 2026-11',
  createdAt: '2026-11-15T14:02:00Z',
  startedBy: 'Ada',
  albums: 1812,
  outcomes: { pick: 1646, none: 166 },
  spent: 0,
  spentOther: [],
  currency: 'USD',
  projected: null,
};

export const RUN_RUNNING: RunView = {
  ...RUN_DONE, id: 'run-2', deciderId: 'jev', modelLabel: 'Jev 2026-09', state: 'running', outcomes: { pick: 512, none: 61, too_large: 3 }, spent: 1.84, projected: 5.81,
};

export const runPaused = (pauseReason: string): RunView => ({ ...RUN_RUNNING, id: `run-p-${pauseReason}`, state: 'paused', pauseReason });

export const PAUSE_REASONS = ['module_off', 'no_key', 'no_cap', 'no_price', 'cap_reached', 'key_refused', 'spec_changed'] as const;

export const RUN_BACKTEST: RunView = { ...RUN_DONE, id: 'run-0', population: 'backtest', createdAt: '2026-11-09T21:40:00Z', albums: 1912, outcomes: { pick: 1730, none: 182 } };
export const RUN_WEAK: RunView = { ...RUN_RUNNING, id: 'run-w', population: 'weak', state: 'cancelled', createdAt: '2026-11-02T10:15:00Z', albums: 500, outcomes: { pick: 412, none: 88 }, spent: 4.2, projected: null };

const row = (r: Partial<BandRow> & Pick<BandRow, 'band' | 'picks'>): BandRow => ({
  drawn: 0, checked: 0, errors: 0, unsure: 0, pending: 0, upper: 1, allowed: false, stillNeeded: null, accepted: 0, ...r,
});

/** p99 open (299 clean), p97 checking (1 wrong), p95 and p90 not drawn. */
export const BANDS: BandRow[] = [
  row({ band: 'p99', picks: 1204, drawn: 300, checked: 299, errors: 0, pending: 1, upper: 0.00997, allowed: true, stillNeeded: 0 }),
  row({ band: 'p97', picks: 233, drawn: 125, checked: 113, errors: 1, pending: 12, upper: 0.0412, allowed: false, stillNeeded: 360 }),
  row({ band: 'p95', picks: 121 }),
  row({ band: 'p90', picks: 88 }),
];

/** Nothing checked yet: every gate shut. */
export const BANDS_CLOSED: BandRow[] = BANDS.map((b) => row({ band: b.band, picks: b.picks, drawn: b.band === 'p99' ? 25 : 0, checked: b.band === 'p99' ? 24 : 0, pending: b.band === 'p99' ? 1 : 0, upper: b.band === 'p99' ? 0.117 : 1, stillNeeded: b.band === 'p99' ? 275 : null }));

/** p99 accepted already, p97 now open too. */
export const BANDS_ACCEPTED: BandRow[] = [
  { ...BANDS[0]!, accepted: 1204 },
  { ...BANDS[1]!, drawn: 300, checked: 300, pending: 0, errors: 0, upper: 0.00994, allowed: true, stillNeeded: 0 },
  BANDS[2]!,
  BANDS[3]!,
];

const tracks = [
  ['Lanterns on the Weir', '4:58', '4:59'],
  ['Copper Season', '3:02', '3:03'],
  ['The Long Field', '4:41', '4:41'],
  ['Saltglass', '3:07', '3:07'],
  ['Night Ferry', '5:10', '5:10'],
  ['A House of Rain', '4:12', '4:12'],
  ['Hollow Bells', '3:49', '3:48'],
  ['Northern Light, Southern Shore', '6:20', '6:21'],
] as const;

export const CHECK: SpotCheckItem = {
  id: 'check-1',
  band: 'p97',
  verdict: 'pending',
  album: { id: 'album-1', title: 'Glass Orchard', artist: 'Mira Vale', year: 1985, tracks: tracks.map(([title, mine], i) => ({ n: i + 1, title, length: mine })) },
  chosen: {
    releaseId: 'rel-1', title: 'Glass Orchard', year: 1997, country: 'GB', label: 'Northlight', format: 'CD', source: 'musicbrainz',
    tracks: tracks.map(([title, , theirs], i) => ({ n: i + 1, title, length: theirs })),
  },
  probability: 0.9731,
  groupSize: 6,
  stale: false,
};

export const CHECK_STALE: SpotCheckItem = { ...CHECK, id: 'check-2', stale: true, groupSize: 1 };

export const ACCEPT_PREVIEW: AcceptPreview = {
  band: 'p99',
  albums: 1203,
  excludedWrong: 1,
  alreadyAccepted: 0,
  notPinned: 4,
  gate: { upper: 0.00997, allowed: true, stillNeeded: 0 },
  cannotUndo: ['Album identity already pulled by linked apps', 'Tag plans already applied'],
  linkedApps: 2,
  drain: { pending: 3400, perNight: 2000, nights: 2, limit: 400 },
};

export const BATCH_ACCEPTED: BatchSummary = {
  id: 'batch-2', deciderId: 'local', deciderLabel: 'Local 2026-11', decidedKind: 'model', band: 'p99', state: 'accepted',
  createdAt: '2026-11-15T15:20:00Z', startedBy: 'Ada',
  counts: { accepted: 1198, skipped: 5, undone: 0, left: 0, pending: 0 },
  pendingLabel: 'Not reached', failedDuring: null, message: null,
  drain: { pending: 3400, perNight: 2000, nights: 2, limit: 400 },
};

export const BATCH_UNDONE: BatchSummary = {
  id: 'batch-1', deciderId: 'rules', deciderLabel: 'Your rules', decidedKind: 'rule', band: null, state: 'undone',
  createdAt: '2026-10-27T09:00:00Z', startedBy: 'Ada',
  counts: { accepted: 0, skipped: 2, undone: 38, left: 2, pending: 0 },
  pendingLabel: 'Not reached', failedDuring: null, message: null, drain: null,
};

export const BATCH_DETAIL: BatchDetail = {
  ...BATCH_UNDONE,
  skipped: [
    { albumId: 'a-s1', title: 'Paper Moons', artist: 'The Lowlands', reason: 'state' },
    { albumId: 'a-s2', title: 'Tidewater', artist: 'Ines Kroll', reason: 'evidence_changed' },
  ],
  left: [
    { albumId: 'a-l1', title: 'Field Recordings, Vol. 2', artist: 'Okon Ward', reason: 'newer_decision' },
    { albumId: 'a-l2', title: 'Low Winter Sun', artist: 'Mira Vale', reason: 'locks' },
  ],
  cannotUndo: ['Album identity already pulled by linked apps', 'Tag plans already applied'],
};

export const PAYLOAD: PayloadPreview = {
  albumId: 'album-1',
  title: 'Glass Orchard',
  artist: 'Mira Vale',
  bytes: 3_612,
  groups: 3,
  request: {
    model: 'jev-latest',
    state: {
      task: 'Which tracklist group is the owner’s album?',
      local: { title: 'Glass Orchard', artist: 'Mira Vale', year: 1985, tracks: tracks.slice(0, 3).map(([title, mine], i) => ({ n: i + 1, title, length: mine })) },
      tracklists: { A: { releases: 6, tracks: 8 }, B: { releases: 1, tracks: 10 }, C: { releases: 2, tracks: 8 } },
    },
    questions: { A: { type: 'boolean', instructions: 'Is group A the same album?', criteria: { true: 'same album', false: 'another album' } } },
  },
};

export const MODULE: AutotaggerModuleView = {
  enabled: true,
  runs: 4,
  decisions: 5612,
  prices: [{ model: '*', perMillionInput: 0.4, currency: 'USD' }, { model: 'jev-2026-09-15', perMillionInput: 0.35, currency: 'USD' }],
};

export const AGREEMENT: AgreementView = {
  backtest: {
    runId: 'run-0',
    rows: [
      { band: 'p99', decided: 1104, agree: 1101, disagree: 3, noDecision: 0 },
      { band: 'p97', decided: 382, agree: 371, disagree: 11, noDecision: 0 },
      { band: 'p95', decided: 151, agree: 142, disagree: 9, noDecision: 0 },
      { band: 'p90', decided: 93, agree: 84, disagree: 9, noDecision: 0 },
      { band: 'none', decided: 0, agree: 0, disagree: 0, noDecision: 182 },
    ],
  },
  queue: [],
};

/** The album page's match, decided by each kind. */
export const MODEL_MATCH = {
  decidedBy: 'system', decidedKind: 'model' as const, deciderId: 'jev', deciderVersion: 'jev-2026-09-15', probability: 0.994,
  batch: { id: 'b', createdAt: '2026-10-27T09:00:00Z', startedBy: 'Ada' }, person: null, reason: null,
};
export const RULE_MATCH = { ...MODEL_MATCH, decidedKind: 'rule' as const, deciderId: 'rules', deciderVersion: null, probability: null };
export const HAND_MATCH = { ...MODEL_MATCH, decidedBy: 'user', decidedKind: 'user' as const, deciderId: null, deciderVersion: null, probability: null, batch: null, person: 'Ada' };
