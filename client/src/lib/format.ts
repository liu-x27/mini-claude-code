/** A cost for display; null means the server has no price for the model. */
export function usd(cost: number | null, digits: number): string {
  return cost === null ? "cost unknown" : `$${cost.toFixed(digits)}`;
}
