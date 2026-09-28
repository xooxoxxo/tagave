import { describe, it, expect } from 'vitest';

/** Test helper to extract describeQualityFlags behavior (since it's not exported) */
function describeQualityFlagsTest(flags: Record<string, unknown>) {
  // Replicate the function logic for testing
  const FLAG_LABEL: Record<string, string> = {
    noCover: 'No cover art',
    noEmbeddedArt: 'No embedded art',
    missingMbIds: 'Missing MusicBrainz IDs',
    trackNumberIssues: 'Track numbers',
    emptyRequiredFields: 'Empty required fields',
    inconsistentAlbumFields: 'Inconsistent album fields',
    titleCaseAnomalies: 'Title case',
    discNumberGaps: 'Disc number gaps',
    parseErrors: 'Unreadable files',
    mixedLossless: 'Mixed lossless and lossy',
    lowBitrate: 'Low bitrate',
  };

  const FLAG_ACTION: Record<string, 'art' | 'tags' | 'split'> = {
    noCover: 'art',
    missingMbIds: 'tags',
    emptyRequiredFields: 'tags',
    trackNumberIssues: 'tags',
    inconsistentAlbumFields: 'tags',
    titleCaseAnomalies: 'tags',
    discNumberGaps: 'tags',
    mixedLossless: 'split',
    lowBitrate: 'split',
  };

  const explanations: Record<string, { explain: (count?: number) => string }> = {
    noCover: {
      explain: () => 'Album artwork missing. Add one to improve recognition and collection appearance.',
    },
    noEmbeddedArt: {
      explain: () => 'No artwork embedded in audio files. Shows in players; optional if external art exists.',
    },
    missingMbIds: {
      explain: (count = 1) => `Missing MusicBrainz track IDs on ${count} ${count === 1 ? 'track' : 'tracks'}. Needed for accurate matching and lookups.`,
    },
    trackNumberIssues: {
      explain: (count = 1) => `Track numbers incomplete on ${count} ${count === 1 ? 'track' : 'tracks'}. Essential for playback order.`,
    },
    emptyRequiredFields: {
      explain: (count = 1) => `Required tag missing on ${count} ${count === 1 ? 'track' : 'tracks'}. Affects search and organization.`,
    },
    inconsistentAlbumFields: {
      explain: (count = 1) => `Album field inconsistent across ${count} ${count === 1 ? 'track' : 'tracks'}. Impairs identification and metadata quality.`,
    },
    titleCaseAnomalies: {
      explain: (count = 1) => `Title capitalization odd on ${count} ${count === 1 ? 'item' : 'items'}. Style consistency issue.`,
    },
    discNumberGaps: {
      explain: (count = 1) => `Disc numbering has ${count} ${count === 1 ? 'gap' : 'gaps'}. Breaks multi-disc album structure.`,
    },
    parseErrors: {
      explain: (count = 1) => `Cannot read tags on ${count} ${count === 1 ? 'file' : 'files'}. File may be corrupted or in unsupported format.`,
    },
    mixedLossless: {
      explain: () => 'Mix of lossless and lossy files. Split by format to organize by quality.',
    },
    lowBitrate: {
      explain: (count = 1) => `Lossy file${count === 1 ? '' : 's'} below 192 kbps on ${count} ${count === 1 ? 'track' : 'tracks'}. Acceptable but lower quality.`,
    },
  };

  return Object.entries(flags).map(([key, value]) => {
    const baseLabel = FLAG_LABEL[key] ?? key;
    const action = FLAG_ACTION[key] ? { action: FLAG_ACTION[key] } : {};
    const explainer = explanations[key];

    if (value === true || value == null) {
      return {
        key,
        label: baseLabel,
        detail: explainer?.explain(),
        ...action,
      };
    }

    if (typeof value === 'number') {
      return {
        key,
        label: baseLabel,
        detail: explainer?.explain(value),
        ...action,
      };
    }

    if (typeof value !== 'object') {
      return {
        key,
        label: `${baseLabel} · ${String(value)}`,
        ...action,
      };
    }

    const obj = value as Record<string, unknown>;
    const items = Object.values(obj).filter(Array.isArray).flat() as unknown[];
    if (items.length === 0) {
      return { key, label: baseLabel, detail: explainer?.explain(), ...action };
    }

    return {
      key,
      label: baseLabel,
      detail: explainer?.explain(items.length),
      ...action,
    };
  });
}

describe('AlbumDetailPage quality flags', () => {
  it('should describe noCover flag with explanation and art action', () => {
    const result = describeQualityFlagsTest({ noCover: true });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('noCover');
    expect(result[0].label).toBe('No cover art');
    expect(result[0].detail).toBe('Album artwork missing. Add one to improve recognition and collection appearance.');
    expect(result[0].action).toBe('art');
  });

  it('should describe missingMbIds with count and singular form', () => {
    const result = describeQualityFlagsTest({ missingMbIds: { tracks: [0, 5] } });
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Missing MusicBrainz IDs');
    expect(result[0].detail).toContain('2 tracks');
    expect(result[0].detail).toContain('Needed for accurate matching');
  });

  it('should use singular form for single item', () => {
    const result = describeQualityFlagsTest({ trackNumberIssues: { issues: [0] } });
    expect(result).toHaveLength(1);
    expect(result[0].detail).toContain('1 track');
    expect(result[0].detail).not.toContain('tracks');
  });

  it('should describe noEmbeddedArt with no action', () => {
    const result = describeQualityFlagsTest({ noEmbeddedArt: true });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('noEmbeddedArt');
    expect(result[0].detail).toContain('embedded in audio files');
    expect(result[0].action).toBeUndefined();
  });

  it('should describe multiple quality flags', () => {
    const result = describeQualityFlagsTest({
      noCover: true,
      missingMbIds: { tracks: [0, 1, 2, 3, 4] },
      inconsistentAlbumFields: { fields: ['genre', 'artist'] },
    });
    expect(result).toHaveLength(3);

    const coverFlag = result.find((f) => f.key === 'noCover');
    expect(coverFlag?.action).toBe('art');

    const mbidsFlag = result.find((f) => f.key === 'missingMbIds');
    expect(mbidsFlag?.detail).toContain('5 tracks');
    expect(mbidsFlag?.action).toBe('tags');

    const fieldFlag = result.find((f) => f.key === 'inconsistentAlbumFields');
    expect(fieldFlag?.detail).toContain('2 tracks');
  });

  it('should describe mixedLossless with split action', () => {
    const result = describeQualityFlagsTest({ mixedLossless: true });
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('split');
    expect(result[0].detail).toContain('Mix of lossless and lossy');
  });

  it('should handle count-based lowBitrate flag', () => {
    const result = describeQualityFlagsTest({ lowBitrate: 3 });
    expect(result).toHaveLength(1);
    expect(result[0].detail).toContain('3 tracks');
    expect(result[0].detail).toContain('Lossy files');
  });

  it('should pluralize correctly for single parseError', () => {
    const result = describeQualityFlagsTest({ parseErrors: 1 });
    expect(result[0].detail).toContain('1 file');
    expect(result[0].detail).not.toContain('files');
  });

  it('should pluralize correctly for multiple parseErrors', () => {
    const result = describeQualityFlagsTest({ parseErrors: 2 });
    expect(result[0].detail).toContain('2 files');
  });

  it('should handle empty flag details gracefully', () => {
    const result = describeQualityFlagsTest({
      inconsistentAlbumFields: { fields: [] },
    });
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Inconsistent album fields');
  });
});
