/** Tokenize into words for MiniSearch (space = terms; AND is applied in searchOptions). */
export function keywordsToMiniSearchAnd(user: string): string {
  const tokens = user.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.join(" ");
}
