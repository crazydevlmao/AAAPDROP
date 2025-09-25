// lib/price.ts
// Fetch $PUMP price + 24h change from Jupiter lite API (no key required).
const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

// Response shape:
// {
//   "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn": {
//     "usdPrice": 0.00585,
//     "blockId": 368813074,
//     "decimals": 6,
//     "priceChange24h": 1.0332
//   }
// }

export async function pumpPriceInfo(): Promise<{ price: number; change24h: number }> {
  try {
    const url = `https://lite-api.jup.ag/price/v3?ids=${PUMP_MINT}`;
    const r = await fetch(url, {
      // avoid stale values; API is fast/light
      cache: "no-store",
      // for Next, still allow ISR if needed:
      next: { revalidate: 15 },
    });
    if (!r.ok) return { price: 0, change24h: 1 };
    const j = await r.json();
    const entry = j?.[PUMP_MINT];
    const price = typeof entry?.usdPrice === "number" ? entry.usdPrice : 0;
    const change = typeof entry?.priceChange24h === "number" ? entry.priceChange24h : 1;
    return { price, change24h: change };
  } catch {
    return { price: 0, change24h: 1 };
  }
}

// Back-compat
export async function pumpPrice(): Promise<number> {
  const { price } = await pumpPriceInfo();
  return price;
}