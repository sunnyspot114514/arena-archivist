function compact(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function subsequenceScore(value: string, query: string): number {
  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (
    let index = 0;
    index < value.length && queryIndex < query.length;
    index += 1
  ) {
    if (value[index] !== query[queryIndex]) continue;
    if (firstMatch === -1) firstMatch = index;
    lastMatch = index;
    queryIndex += 1;
  }

  if (queryIndex !== query.length || firstMatch === -1) return 0;
  const span = lastMatch - firstMatch + 1;
  const density = query.length / span;
  const endingBonus = lastMatch === value.length - 1 ? 0.1 : 0;
  return Math.min(0.79, 0.4 + density * 0.3 + endingBonus);
}

function scoreOne(value: string, query: string): number {
  if (value === query) return 1;
  if (value.startsWith(query)) return 0.95;
  if (value.includes(query)) return 0.85;
  return subsequenceScore(value, query);
}

export function scoreModelIdMatch(
  modelId: string,
  search: string,
  keywords: string[] = [],
): number {
  const query = compact(search);
  if (!query) return 1;

  const candidates = [
    modelId,
    modelId.split('/').at(-1) ?? modelId,
    ...keywords,
  ];
  return Math.max(
    ...candidates.map((candidate) => scoreOne(compact(candidate), query)),
  );
}
