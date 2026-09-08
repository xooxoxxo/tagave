/**
 * Tag mapping and utilities.
 */
export {
  TAG_MAPPING,
  MULTI_VALUE_FIELDS,
  getTagNamesForFormat,
  isMultiValueField,
  joinMultiValue,
  splitMultiValue,
} from './mapping.js';

export type { FormatTagMapping } from './mapping.js';
export type { TagSet } from './mapping.js';

export {
  resolveFields,
} from './resolveFields.js';

export type { ResolvedField, ResolvedMetadata, ResolutionInput, FieldLock } from './resolveFields.js';

export {
  lintAlbum,
} from './lintRules.js';

export type { LintFlag, LintToggles, RawTrackTags } from './lintRules.js';
