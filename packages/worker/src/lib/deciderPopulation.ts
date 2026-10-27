/**
 * Which albums a decider run sends: in @tagave/db, so the api's payload
 * preview picks its album by the same rules; this module only names them
 * for the worker.
 */
export { MEASURE_LARGEST, MEASURE_SAMPLE, albumPopulation, populationAlbumIds, type PopulationOptions } from '@tagave/db';
export { WEAK_TOP_CANDIDATES } from '@tagave/core';
