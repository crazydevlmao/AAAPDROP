// lib/db.ts
import { promises as fs } from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const files = {
  preps: path.join(dataDir, "preps.json"),
  snapshots: path.join(dataDir, "snapshots.json"),
  entitlements: path.join(dataDir, "entitlements.json"),
  claims: path.join(dataDir, "claims.json"),
  metrics: path.join(dataDir, "metrics.json"),
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

  // === NEW: written by prepare-drop, read by proofs (DB-backed, no RPC spam)
  creatorSol?: number;      // SOL actually received on DEV for this cycle
  pumpSwapped?: number;     // PUMP amount swapped into Treasury for this cycle (UI units)
  swapSig?: string;         // primary swap tx (Solscan link derives from this)

  status: "ok" | "swap_failed_or_dust" | "error";
  ts: string;
};

export type Snapshot = {
  cycleId: string;       // UNIQUE (per-window)
  snapshotId: string;    // we use = cycleId
  snapshotTs: string;
  deltaPump: number;
  eligibleCount: number;
  holdersHash: string;
  holdersCsvPath?: string;
};

export type Entitlement = {
  snapshotId: string;    // part of UNIQUE (snapshotId, wallet)
  wallet: string;        // lowercase preferred; part of UNIQUE
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

// ===== Per-file write queue (prevents concurrent write corruption) =====
const WRITE_QUEUE = new Map<string, Promise<void>>();
function enqueueWrite(target: string, task: () => Promise<void>) {
  const prev = WRITE_QUEUE.get(target) || Promise.resolve();
  const next = prev.then(task).catch(() => {}).finally(() => {
    if (WRITE_QUEUE.get(target) === next) WRITE_QUEUE.delete(target);
  });
  WRITE_QUEUE.set(target, next);
  return next;
}

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
  const tmp = `${f}.tmp`;
  const payload = JSON.stringify(rows, null, 2);
  await enqueueWrite(f, async () => {
    await fs.writeFile(tmp, payload);
    await fs.rename(tmp, f);
  });
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
  const tmp = `${f}.tmp`;
  const payload = JSON.stringify(obj, null, 2);
  await enqueueWrite(f, async () => {
    await fs.writeFile(tmp, payload);
    await fs.rename(tmp, f);
  });
}

// ===== De-dupe helpers =====
function dedupeSnapshotsKeepEarliest(rows: Snapshot[]): Snapshot[] {
  const byCycle = new Map<string, Snapshot>();
  for (const s of rows) {
    const key = String(s.cycleId);
    const prev = byCycle.get(key);
    if (!prev) byCycle.set(key, s);
    else if (new Date(s.snapshotTs).getTime() < new Date(prev.snapshotTs).getTime()) byCycle.set(key, s);
  }
  const sorted = Array.from(byCycle.values()).sort((a, b) => Number(a.cycleId) - Number(b.cycleId));
  const RETAIN = 200;
  return sorted.slice(-RETAIN);
}

function dedupeEntitlementsMerge(rows: Entitlement[]): Entitlement[] {
  const map = new Map<string, Entitlement>();
  for (const r of rows) {
    const wallet = String(r.wallet || "").toLowerCase();
    const key = `${r.snapshotId}::${wallet}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...r, wallet });
    } else {
      const claimed = prev.claimed || r.claimed;
      const claimSig = r.claimSig || prev.claimSig;
      map.set(key, { ...prev, claimed, claimSig });
    }
  }
  return Array.from(map.values());
}

// ===== Claims dedupe by signature =====
function dedupeClaimsBySig(rows: Claim[]): Claim[] {
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const c of rows) {
    const sig = String(c.sig || "");
    if (!sig) continue;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({
      wallet: String(c.wallet || "").toLowerCase(),
      amount: Number(c.amount || 0),
      ts: new Date(c.ts || Date.now()).toISOString(),
      sig,
    });
  }
  // newest first (not required, but keeps file stable)
  return out.sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
}

// ===== Public DB API =====
export const db = {
  // ---- preps ----
  async upsertPrep(p: Prep) {
    const rows = await read<Prep>(files.preps);
    const i = rows.findIndex(r => r.cycleId === p.cycleId);
    if (i >= 0) {
      // merge to avoid wiping optional fields not provided by the caller
      rows[i] = { ...rows[i], ...p };
    } else {
      rows.push(p);
    }
    await write(files.preps, rows);
  },
  async getPrep(cycleId: string): Promise<Prep | undefined> {
    const rows = await read<Prep>(files.preps);
    return rows.find(r => r.cycleId === cycleId);
  },

  // ---- snapshots ----
  /** Idempotent add: one snapshot per cycleId (keeps earliest). */
  async addSnapshot(s: Snapshot) {
    const rows = await read<Snapshot>(files.snapshots);
    rows.push(s);
    const deduped = dedupeSnapshotsKeepEarliest(rows);
    await write(files.snapshots, deduped);
  },
  async getSnapshot(cycleId: string): Promise<Snapshot | undefined> {
    const rows = await read<Snapshot>(files.snapshots);
    const deduped = dedupeSnapshotsKeepEarliest(rows);
    return deduped.find(r => r.cycleId === cycleId);
  },
  async getLatestSnapshot(): Promise<Snapshot | undefined> {
    const rows = await read<Snapshot>(files.snapshots);
    const deduped = dedupeSnapshotsKeepEarliest(rows);
    return deduped[deduped.length - 1];
  },
  async listSnapshots(limit?: number): Promise<Snapshot[]> {
    const rows = await read<Snapshot>(files.snapshots);
    const deduped = dedupeSnapshotsKeepEarliest(rows);
    const desc = deduped.slice().reverse();
    const prevOnly = desc.slice(1);
    return typeof limit === "number" && limit > 0 ? prevOnly.slice(0, limit) : prevOnly;
  },

  // ---- entitlements ----
  /** Idempotent add: one row per (snapshotId, wallet). */
  async addEntitlements(rowsIn: Entitlement[]) {
    const rows = await read<Entitlement>(files.entitlements);
    const combined = rows.concat(
      rowsIn.map(r => ({ ...r, wallet: String(r.wallet || "").toLowerCase() }))
    );
    const deduped = dedupeEntitlementsMerge(combined);
    await write(files.entitlements, deduped);
  },
  async listWalletEntitlements(wallet: string) {
    const rows = await read<Entitlement>(files.entitlements);
    const deduped = dedupeEntitlementsMerge(rows);
    const w = wallet.toLowerCase();
    return deduped.filter(r => r.wallet === w);
  },
  async markEntitlementsClaimed(wallet: string, snapshotIds: string[], sig: string) {
    const rows = await read<Entitlement>(files.entitlements);
    const w = wallet.toLowerCase();
    for (const r of rows) {
      if (r.wallet.toLowerCase() === w && snapshotIds.includes(r.snapshotId)) {
        r.claimed = true;
        r.claimSig = r.claimSig || sig;
      }
    }
    const deduped = dedupeEntitlementsMerge(rows);
    await write(files.entitlements, deduped);
  },

  // ---- claims feed (idempotent via sig) ----
  async addClaim(c: Claim) {
    const rows = await read<Claim>(files.claims);
    const normalized = {
      wallet: String(c.wallet || "").toLowerCase(),
      amount: Number(c.amount || 0),
      ts: new Date(c.ts || Date.now()).toISOString(),
      sig: String(c.sig || ""),
    };
    rows.push(normalized);
    const deduped = dedupeClaimsBySig(rows);
    await write(files.claims, deduped);
  },

  async insertRecentClaim({ wallet, amount, sig, ts }: { wallet: string; amount: number; sig: string; ts: string }) {
    return db.addClaim({ wallet, amount, sig, ts });
  },

  async recentClaims(limit = 50): Promise<Claim[]> {
    const rows = await read<Claim>(files.claims);
    const deduped = dedupeClaimsBySig(rows);
    return deduped.slice(0, limit);
  },

  async recentClaimsByWallet(wallet: string, limit = 50): Promise<Claim[]> {
    const rows = await read<Claim>(files.claims);
    const w = wallet.toLowerCase();
    const deduped = dedupeClaimsBySig(rows);
    return deduped.filter(r => r.wallet === w).slice(0, limit);
  },

  // ---- aggregates / metrics ----
  async addToTotalDistributed(amount: number) {
    // Keep simple additive counter; caller should ensure idempotency by sig.
    const m = await readObj<Metrics>(files.metrics, { totalDistributedPump: 0 });
    m.totalDistributedPump = Number(m.totalDistributedPump || 0) + Number(amount || 0);
    await writeObj(files.metrics, m);
  },

  /** Returns the *claimed* total. Prefer metrics.json; fallback to sum(claims). */
  async totalDistributedPump(): Promise<number> {
    const m = await readObj<Metrics>(files.metrics, { totalDistributedPump: 0 });
    const fromMetrics = Number(m.totalDistributedPump || 0);
    if (fromMetrics > 0) return fromMetrics;

    const claims = await read<Claim>(files.claims);
    const deduped = dedupeClaimsBySig(claims);
    return deduped.reduce((acc, c) => acc + Number(c.amount || 0), 0);
  },
};
