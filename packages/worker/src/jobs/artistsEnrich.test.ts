import { describe, it, expect } from 'vitest';
import { extractIdentityFromUrlRels, isStale } from './artistsEnrich.js';

describe('artistsEnrich helpers', () => {
  describe('extractIdentityFromUrlRels', () => {
    it('should extract wikidata QID', () => {
      const urlRels = [
        { type: 'wikidata', url: 'https://www.wikidata.org/wiki/Q12345' },
      ];
      const result = extractIdentityFromUrlRels(urlRels);
      expect(result.wikidataQid).toBe('Q12345');
    });

    it('should extract wikipedia title', () => {
      const urlRels = [
        { type: 'wikipedia', url: 'https://en.wikipedia.org/wiki/David_Bowie' },
      ];
      const result = extractIdentityFromUrlRels(urlRels);
      expect(result.wikipediaTitle).toBe('David_Bowie');
    });

    it('should extract both qid and title', () => {
      const urlRels = [
        { type: 'wikidata', url: 'https://www.wikidata.org/wiki/Q5383' },
        { type: 'wikipedia', url: 'https://en.wikipedia.org/wiki/David_Bowie' },
      ];
      const result = extractIdentityFromUrlRels(urlRels);
      expect(result.wikidataQid).toBe('Q5383');
      expect(result.wikipediaTitle).toBe('David_Bowie');
    });

    it('should handle empty array', () => {
      const result = extractIdentityFromUrlRels([]);
      expect(result).toEqual({});
    });

    it('should handle undefined', () => {
      const result = extractIdentityFromUrlRels(undefined);
      expect(result).toEqual({});
    });
  });

  describe('isStale', () => {
    it('should return true for null enrichedAt', () => {
      const now = new Date();
      expect(isStale(null, now)).toBe(true);
    });

    it('should return true for undefined enrichedAt', () => {
      const now = new Date();
      expect(isStale(undefined, now)).toBe(true);
    });

    it('should return false for recent enrichedAt', () => {
      const now = new Date();
      const enrichedAt = new Date(now.getTime() - 24 * 3600 * 1000); // 1 day ago
      expect(isStale(enrichedAt, now)).toBe(false);
    });

    it('should return true for old enrichedAt', () => {
      const now = new Date();
      const enrichedAt = new Date(now.getTime() - 8 * 24 * 3600 * 1000); // 8 days ago
      expect(isStale(enrichedAt, now)).toBe(true);
    });

    it('should return true at exactly 7 days', () => {
      const now = new Date();
      const enrichedAt = new Date(now.getTime() - 7 * 24 * 3600 * 1000); // 7 days ago
      expect(isStale(enrichedAt, now)).toBe(false); // < not <=
    });
  });
});
