/** Small string scores. Ratio follows an indel similarity, the same idea as RapidFuzz. */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + cost);
      previous = current;
    }
  }
  return row[b.length];
}

function indel(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 2;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + cost);
      previous = current;
    }
  }
  return row[b.length];
}

export function ratio(a: string, b: string): number {
  if (a === b) return 100;
  const denom = a.length + b.length;
  if (!denom) return 100;
  return (100 * (denom - indel(a, b))) / denom;
}

export function tokenSortRatio(a: string, b: string): number {
  const sort = (value: string) => value.split(" ").filter(Boolean).sort().join(" ");
  return ratio(sort(a), sort(b));
}

export function partialAlignment(
  needle: string,
  haystack: string,
): { score: number; snippet: string; distance: number } | null {
  if (!needle || !haystack) return null;
  const width = needle.length;
  if (haystack.length <= width) {
    return {
      score: ratio(needle, haystack),
      snippet: haystack,
      distance: levenshtein(needle, haystack),
    };
  }
  let bestScore = -1;
  let bestIndex = 0;
  const step = Math.max(1, Math.floor(width / 20));
  for (let index = 0; index <= haystack.length - width; index += step) {
    const score = ratio(needle, haystack.slice(index, index + width));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  const start = Math.max(0, bestIndex - step);
  const end = Math.min(haystack.length - width, bestIndex + step);
  for (let index = start; index <= end; index += 1) {
    const score = ratio(needle, haystack.slice(index, index + width));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  const snippet = haystack.slice(bestIndex, bestIndex + width);
  return { score: bestScore, snippet, distance: levenshtein(needle, snippet) };
}
