// Brand ranking for visibility-rank.ts. Pure so the tie and zero-share rules
// can be unit tested: brands with zero share are unranked (rank null), and
// equal shares get the same competition rank (1, 2, 2, 4).

export interface RankedBrand {
  brand: string;
  share: number; // 0-100
  rank: number | null; // null when share is 0 - absent is not "last place"
}

export function rankBrands(shares: Record<string, number>): RankedBrand[] {
  const sorted = Object.entries(shares)
    .map(([brand, share]) => ({ brand, share }))
    .sort((a, b) => b.share - a.share || a.brand.localeCompare(b.brand));
  const out: RankedBrand[] = [];
  let prevShare: number | null = null;
  let prevRank = 0;
  for (const [i, b] of sorted.entries()) {
    if (b.share <= 0) {
      out.push({ ...b, rank: null });
      continue;
    }
    const rank = b.share === prevShare ? prevRank : i + 1;
    out.push({ ...b, rank });
    prevShare = b.share;
    prevRank = rank;
  }
  return out;
}
