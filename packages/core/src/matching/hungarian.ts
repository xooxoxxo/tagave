/**
 * Hungarian algorithm (Munkres algorithm) for finding minimum-weight perfect matching.
 * Used for aligning local tracks to canonical tracklist.
 *
 * Implementation based on the standard O(n³) algorithm.
 * Input: cost matrix of size m×n (tracks)
 * Output: assignment array mapping local track index to canonical track index (-1 if unmatched)
 */

/**
 * Result of the Hungarian algorithm: assignment with total cost.
 */
export interface Assignment {
  /** mapping[i] = j means local track i matches canonical track j; -1 means unmatched */
  mapping: number[];
  /** Total cost of the assignment */
  totalCost: number;
  /** Number of matched pairs */
  matched: number;
}

/**
 * Solve the assignment problem using the Hungarian algorithm.
 * Handles rectangular matrices (more rows than columns or vice versa).
 *
 * @param costMatrix - rectangular matrix of costs (rows = local tracks, cols = canonical tracks)
 * @returns Assignment with mapping and total cost
 */
export function hungarianAlgorithm(costMatrix: number[][]): Assignment {
  if (costMatrix.length === 0) {
    return { mapping: [], totalCost: 0, matched: 0 };
  }

  const rows = costMatrix.length;
  const cols = costMatrix[0]?.length || 0;

  if (cols === 0) {
    return { mapping: Array(rows).fill(-1), totalCost: 0, matched: 0 };
  }

  // Pad to square matrix if needed
  const size = Math.max(rows, cols);
  const matrix: number[][] = [];
  const maxCost = costMatrix.flat().reduce((a, b) => Math.max(a, b), 0) + 1;

  for (let i = 0; i < size; i++) {
    const row: number[] = [];
    for (let j = 0; j < size; j++) {
      if (i < rows && j < cols) {
        row[j] = costMatrix[i]?.[j] ?? maxCost;
      } else {
        // Padding with high cost (unmatched)
        row[j] = maxCost;
      }
    }
    matrix[i] = row;
  }

  // Apply Hungarian algorithm
  const u = new Array(size + 1).fill(0); // dual variables for rows
  const v = new Array(size + 1).fill(0); // dual variables for cols
  const p = new Array(size + 1).fill(0); // p[j] = row matched to col j
  const way = new Array(size + 1).fill(0);

  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(size + 1).fill(Infinity);
    const used = new Array(size + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= size; j++) {
        if (!used[j]) {
          const cur = matrix[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
          if (cur < minv[j]!) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j]! < delta) {
            delta = minv[j]!;
            j1 = j;
          }
        }
      }

      for (let j = 0; j <= size; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  // Extract mapping and calculate cost
  const mapping: number[] = [];
  let totalCost = 0;
  let matched = 0;

  for (let i = 0; i < rows; i++) {
    let assigned = -1;
    for (let j = 1; j <= size; j++) {
      if (p[j] === i + 1) {
        const cost = costMatrix[i]?.[j - 1];
        if (j - 1 < cols && cost !== undefined && cost < maxCost) {
          assigned = j - 1;
          totalCost += cost;
          matched++;
        }
        break;
      }
    }
    mapping.push(assigned);
  }

  return { mapping, totalCost, matched };
}
