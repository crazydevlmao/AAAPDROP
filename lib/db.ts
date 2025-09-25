// lib/db.ts
import { promises as fs } from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const files = {
  preps: path.join(dataDir, "preps.json"),
  snapshots: path.join(dataDir, "snapshots.json"),
  entitlements: path.join(dataDir, "entitlements.json"),
  claims: path.join(dataDir, "claims.json"),
  metrics: path.join(dataDir, "metrics.json"), // NEW
};

// ===== Types =====
export type Prep = {
  cycleId: string;
  acquiredPump: number;
  pumpToTreasury: number;
  pumpToTeam: number;

  creatorSolDelta?: number;
  toTeamSolLamports?: number;
  toTreasurySolLamports?: number;
  toSwapUi?: number;
  swapOutPumpUi?: number;

  claimedSol?: number;
  claimSig?: string;
  teamSig?: string;
  treasuryMoveSig?: string;
  swapSigTreas?: string;

  swapSigs?: string[];
  splitSigs?: string[];

  status: "ok" | "swap_failed_or_dust" | "error";
  ts: string;
};

export type Snapshot = {
  cycleId: string;
  snapshotId: string;
  snapshotTs: string;
  deltaPump: number;
  eligibleCount: number;
  holdersHash: string;
  holdersCsvPath?: string;
};

export type Entitlement = {
  snapshotId: string;
  wallet: string;  // lowercase preferred
  amount: number;
  claimed: boolean;
  claimSig?: string;
};

export type Claim = {
  wallet: string; // lowercase
  amount: number;
  sig: string;
  ts: string;     // ISO
};

type Metrics = {
  totalDistributedPump: number; // running sum of *claimed* PUMP (UI units)
};

// ===== Low-level JSON file helpers =====
async function ensure() {
  await fs.mkdir(dataDir, { recursive: true });

  for (const f of [files.preps, files.snapshots, files.entitlements, files.claims]) {
    try { await fs.access(f); } catch { await fs.writeFile(f, "[]"); }
  }

  try { await fs.access(files.metrics); }
  catch {
    const init: Metrics = { totalDistributedPump: 0 };
    await fs.writeFile(files.metrics, JSON.stringify(init, null, 2));
  }
}

async function read<T>(f: string): Promise<T[]> {
  await ensure();
  const raw = await fs.readFile(f, "utf8");
  return JSON.parse(raw || "[]");
}

async function write<T>(f: string, rows: T[]) {
  await ensure();
  await fs.writeFile(f, JSON.stringify(rows, null, 2));
}

async function readObj<T>(f: string, fallback: T): Promise<T> {
  await ensure();
  try {
    const raw = await fs.readFile(f, "utf8");
    return JSON.parse(raw || "") as T;
  } catch {
    return fallback;
  }
}

async function writeObj<T>(f: string, obj: T) {
  await ensure();
  await fs.writeFile(f, JSON.stringify(obj, null, 2));
}

// ===== Public DB API =====
export const db = {
  // ---- preps ----
  async upsertPrep(p: Prep) {
    const rows = await read<Prep>(files.preps);
    const i = rows.findIndex(r => r.cycleId === p.cycleId);
    if (i >= 0) rows[i] = p; else rows.push(p);
    await write(files.preps, rows);
  },
  async getPrep(cycleId: string): Promise<Prep | undefined> {
    const rows = await read<Prep>(files.preps);
    return rows.find(r => r.cycleId === cycleId);
  },

  // ---- snapshots ----
  async addSnapshot(s: Snapshot) {
    const rows = await read<Snapshot>(files.snapshots);
    rows.push(s);
    const trimmed = rows.slice(-20);
    await write(files.snapshots, trimmed);
  },
  async latestSnapshot(): Promise<Snapshot | undefined> {
    const rows = await read<Snapshot>(files.snapshots);
    return rows[rows.length - 1];
  },
  async listSnapshots(): Promise<Snapshot[]> {
    const rows = await read<Snapshot>(files.snapshots);
    return rows.slice();
  },

  // ---- entitlements ----
  async addEntitlements(rowsIn: Entitlement[]) {
    const rows = await read<Entitlement>(files.entitlements);
    // normalize wallets to lowercase (no behavior change; just consistency)
    rows.push(...rowsIn.map(r => ({ ...r, wallet: r.wallet.toLowerCase() })));
    await write(files.entitlements, rows);
  },
  async listWalletEntitlements(wallet: string) {
    const rows = await read<Entitlement>(files.entitlements);
    const w = wallet.toLowerCase();
    return rows.filter(r => r.wallet.toLowerCase() === w);
  },
  async markEntitlementsClaimed(wallet: string, snapshotIds: string[], sig: string) {
    const rows = await read<Entitlement>(files.entitlements);
    const w = wallet.toLowerCase();
    for (const r of rows) {
      if (r.wallet.toLowerCase() === w && snapshotIds.includes(r.snapshotId) && !r.claimed) {
        r.claimed = true;
        r.claimSig = sig;
      }
    }
    await write(files.entitlements, rows);
  },

  // ---- claims feed ----
  async addClaim(c: Claim) {
    const rows = await read<Claim>(files.claims);
    rows.push({
      ...c,
      wallet: String(c.wallet || "").toLowerCase(),
      amount: Number(c.amount || 0),
      ts: new Date(c.ts || Date.now()).toISOString(),
      sig: String(c.sig || ""),
    });
    await write(files.claims, rows);
  },

  async insertRecentClaim({ wallet, amount, sig, ts }: { wallet: string; amount: number; sig: string; ts: string }) {
    return db.addClaim({ wallet, amount, sig, ts });
  },

  async recentClaims(limit = 50): Promise<Claim[]> {
    const rows = await read<Claim>(files.claims);
    return rows
      .slice()
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
      .slice(0, limit);
  },

  async recentClaimsByWallet(wallet: string, limit = 50): Promise<Claim[]> {
    const rows = await read<Claim>(files.claims);
    const w = wallet.toLowerCase();
    return rows
      .filter(r => r.wallet.toLowerCase() === w)
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
      .slice(0, limit);
  },

  // ---- aggregates / metrics ----
  async addToTotalDistributed(amount: number) {
    const m = await readObj<Metrics>(files.metrics, { totalDistributedPump: 0 });
    m.totalDistributedPump = Number(m.totalDistributedPump || 0) + Number(amount || 0);
    await writeObj(files.metrics, m);
  },

  /** Returns the *claimed* total. Prefer metrics.json; fallback to summing claims.json */
  async totalDistributedPump(): Promise<number> {
    const m = await readObj<Metrics>(files.metrics, { totalDistributedPump: 0 });
    const fromMetrics = Number(m.totalDistributedPump || 0);
    if (fromMetrics > 0) return fromMetrics;

    const claims = await read<Claim>(files.claims);
    return claims.reduce((acc, c) => acc + Number(c.amount || 0), 0);
  },
};
