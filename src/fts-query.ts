/** Tokenize user input into words for the default strict search path. */
export function keywordsToSearchTerms(user: string): string {
  const tokens = user.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.join(" ");
}
