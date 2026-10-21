/** Latest price array pushed on the live socket, so a new subscriber gets it immediately. */
const quotes = new Map<string, number[]>();

export function rememberLiveQuote(canonicalId: string, prices: number[]): void {
  quotes.set(canonicalId, prices);
}

export function readLiveQuote(canonicalId: string): number[] | undefined {
  const prices = quotes.get(canonicalId);
  return prices ? [...prices] : undefined;
}
