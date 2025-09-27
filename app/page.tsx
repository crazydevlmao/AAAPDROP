"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ConnectionProvider,
  WalletProvider,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { VersionedTransaction } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

/* === QUICK CONFIG (paste CA here if you want it to always show up) === */
const COIN_MINT = "DCR8JwTA7qcrWUygwVjBX3TWbiM7ZCTVrWGoKUhSpump" as const;
const TREASURY = process.env.NEXT_PUBLIC_TREASURY || "<SET_TREASURY_WALLET_PUBKEY>";
const FEE_WALLET =
  process.env.NEXT_PUBLIC_FEE_WALLET || "6vYrrqc4Rsj7QhaTY1HN3YRpRmwP5TEq9zss5HKyd5fh";
const ENV_BLACKLIST = process.env.NEXT_PUBLIC_BLACKLIST || ""; // comma-separated
const PUMPFUN_AMM = process.env.NEXT_PUBLIC_PUMPFUN_AMM || ""; // single wallet

const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const RPC_ENDPOINT =
  process.env.NEXT_PUBLIC_SOLANA_RPC ||
  process.env.SOLANA_RPC ||
  "https://api.mainnet-beta.solana.com";

/* === ADDED: gentle client triggers offsets (prep/snapshot) === */
const PREP_OFFSET_SECONDS = Number(process.env.PREP_OFFSET_SECONDS || 120);
const SNAPSHOT_OFFSET_SECONDS = Number(process.env.SNAPSHOT_OFFSET_SECONDS || 8);

/* === Utils === */
function nextBoundary(minutes = CYCLE_MINUTES, from = new Date()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  const r = m % minutes;
  d.setMinutes(r ? m + (minutes - r) : m + minutes);
  return d;
}
function b64ToU8a(b64: string): Uint8Array {
  let binary = "";
  if (typeof atob === "function") binary = atob(b64);
  else if (typeof Buffer !== "undefined") binary = Buffer.from(b64, "base64").toString("binary");
  else throw new Error("No base64 decoder");
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
  return out;
}
function u8aToB64(u8: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)) as any);
  }
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
}
function short(addr?: string, head = 6, tail = 6) {
  if (!addr) return "";
  if (addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
function formatUSD(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function formatMintForHeader(mint?: string) {
  if (!mint || mint.length < 8) return "----.----PUMP";
  return `${mint.slice(0, 4)}.${mint.slice(-4)}`;
}
function timeAgo(iso: string, now = new Date()) {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((+now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* === Types === */
type Holder = { wallet: string; balance: number; display?: string };
type RecentClaim = { wallet: string; amount: number; ts: string; sig: string };

/* === Toast System === */
type ToastType = "success" | "error" | "info";
function Toast({ msg, type }: { msg: string; type: ToastType }) {
  const color =
    type === "success"
      ? "bg-emerald-600 border-emerald-400"
      : type === "error"
      ? "bg-red-600 border-red-400"
      : "bg-[#222] border-[#2a2a33]";
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.98 }}
      className={`px-4 py-3 rounded-xl text-white shadow-lg border ${color}`}
    >
      {msg}
    </motion.div>
  );
}

/* === Tiny confetti (no deps) === */
function fireConfetti() {
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.pointerEvents = "none";
  root.style.zIndex = "99999";
  document.body.appendChild(root);

  const colors = ["#00FFC2", "#ffffff", "#8affea"];
  const pieces = 80;

  for (let i = 0; i < pieces; i++) {
    const s = document.createElement("span");
    s.style.position = "absolute";
    s.style.left = Math.random() * 100 + "%";
    s.style.top = "-10px";
    s.style.width = "6px";
    s.style.height = "10px";
    s.style.background = colors[i % colors.length];
    s.style.opacity = "0.9";
    s.style.borderRadius = "2px";
    s.style.transform = `rotate(${Math.random() * 360}deg)`;
    root.appendChild(s);

    const dx = (Math.random() - 0.5) * 200;
    const dy = 120 + Math.random() * 200;
    const rot = (Math.random() - 0.5) * 720;
    s.animate(
      [
        { transform: `translate(0,0) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 1200 + Math.random() * 600, easing: "cubic-bezier(.2,.7,.3,1)" }
    ).onfinish = () => s.remove();
  }

  setTimeout(() => root.remove(), 2000);
}

/* === Wallet Button (with Disconnect) === */
function ConnectButton() {
  const { setVisible } = useWalletModal();
  const { connected, publicKey, disconnect, disconnecting } = useWallet();
  const label = connected
    ? `Connected · ${short(publicKey?.toBase58?.(), 6, 6)}`
    : "Select Wallet";

  return (
    <div className="flex items-center gap-2 w-full">
      <button
        onClick={() => !connected && setVisible(true)}
        title={connected ? "Wallet connected" : "Select Wallet"}
        disabled={disconnecting}
        className="w-full min-h-[38px] rounded-xl px-4 py-2 text-sm bg-[var(--accent)] text-black font-medium tracking-wide
             flex items-center justify-center transition-all whitespace-nowrap overflow-hidden hover:brightness-95 active:scale-[0.99]"
      >
        <span className="truncate max-w-full">{label}</span>
      </button>

      {connected && (
        <button
          onClick={() => disconnect().catch(() => {})}
          title="Disconnect wallet"
          aria-label="Disconnect wallet"
          className="shrink-0 w-8 h-8 grid place-items-center rounded-md border border-[#2a2a33] bg-[#111118] hover:bg-[#16161c] transition-colors"
          disabled={disconnecting}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M11 2h2v10h-2V2zm7.07 3.93l1.41 1.41A9 9 0 1 1 3.52 7.34l1.41-1.41A7 7 0 1 0 18.07 5.93z"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/* === Inner App === */
function InnerApp() {
  useConnection(); // keep adapter happy
  const { publicKey, signTransaction, connected } = useWallet();

  /* Toast state */
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(null);
  const showToast = (msg: string, type: ToastType = "info", ms = 3000) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), ms);
  };

  /* Countdown (pure UI) */
  const [targetTs, setTargetTs] = useState<Date>(() => nextBoundary(CYCLE_MINUTES));
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  let msLeft = Math.max(0, +targetTs - +now);
  if (msLeft <= 0) {
    const newTarget = nextBoundary(CYCLE_MINUTES, new Date(+now + 1000));
    if (newTarget.getTime() !== targetTs.getTime()) {
      setTargetTs(newTarget);
      msLeft = Math.max(0, +newTarget - +now);
    }
  }

  /* Snapshot + holders state (read-only; server caches) */
  const [holders, setHolders] = useState<Holder[]>([]);
  const [pumpBalance, setPumpBalance] = useState(0);
  const [snapshotTs, setSnapshotTs] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);

  /* Metrics (price + normalized 24h pct change) */
  const [totalDistributedPump, setTotalDistributedPump] = useState(0);
  const [pumpPrice, setPumpPrice] = useState(0);
  const [pumpChangePct, setPumpChangePct] = useState(0);
  const totalUsd = totalDistributedPump * pumpPrice;
  const isUp = pumpChangePct > 0;

  async function refreshMetrics() {
    try {
      const m = await fetch("/api/metrics", { cache: "no-store" }).then((r) => r.json());
      setTotalDistributedPump(m.totalDistributedPump || 0);
      setPumpPrice(m.pumpPrice || 0);
      setPumpChangePct(typeof m.pumpChangePct === "number" ? m.pumpChangePct : 0);
    } catch {}
  }
  useEffect(() => {
    refreshMetrics();
    const id = setInterval(refreshMetrics, 15000);
    return () => clearInterval(id);
  }, []);

  /* Recent claims feed */
  const [recent, setRecent] = useState<RecentClaim[]>([]);
  async function refreshRecent() {
    try {
      const r = await fetch("/api/recent-claims", { cache: "no-store" }).then((r) => r.json());
      setRecent(Array.isArray(r) ? r.slice(0, 50) : []);
    } catch {}
  }
  useEffect(() => {
    refreshRecent();
    const id = setInterval(refreshRecent, 7000);
    return () => clearInterval(id);
  }, []);

  /* History (derived from recent for the connected wallet) */
  const myHistory = useMemo(() => {
    const me = publicKey?.toBase58();
    if (!me) return [];
    return recent.filter((rc) => rc.wallet?.toLowerCase() === me.toLowerCase());
  }, [recent, publicKey?.toBase58?.()]);

  /* Blacklist set: env + PumpFun AMM */
  const blacklistSet = useMemo(() => {
    const base = (ENV_BLACKLIST || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (PUMPFUN_AMM) base.push(PUMPFUN_AMM.trim().toLowerCase());
    return new Set(base);
  }, []);

  /* Entitlements for connected wallet */
  const [claimed, setClaimed] = useState(0);
  const [entitled, setEntitled] = useState(0);
  const [unclaimed, setUnclaimed] = useState(0);
  async function refreshEntitlement(pk: string) {
    try {
      const d = await fetch(`/api/entitlement?wallet=${pk}`).then((r) => r.json());
      setEntitled(d.entitled || 0);
      setClaimed(d.claimed || 0);
      setUnclaimed(d.unclaimed || 0);
    } catch {}
  }
  useEffect(() => {
    if (publicKey) {
      const pk = publicKey.toBase58();
      refreshEntitlement(pk);
      const id = setInterval(() => refreshEntitlement(pk), 15000);
      return () => clearInterval(id);
    }
  }, [publicKey?.toBase58?.()]);

  /* Proofs data (read-only) */
  const [proofs, setProofs] = useState<any>(null);
  async function refreshProofs() {
    try {
      const p = await fetch("/api/proofs", { cache: "no-store" }).then((r) => r.json());
      setProofs(p || null);
      if (p?.pumpBalance) setPumpBalance(Number(p.pumpBalance) || 0);
      if (p?.snapshotTs) setSnapshotTs(p.snapshotTs);
      if (p?.snapshotId) setSnapshotId(p.snapshotId);
    } catch {}
  }
  useEffect(() => {
    refreshProofs();
    const id = setInterval(refreshProofs, 15000);
    return () => clearInterval(id);
  }, []);

  /* 🔁 Poll holders list every 15s (server caches) */
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const res = await fetch("/api/holders", { cache: "no-store" });
        const j = await res.json();
        if (!stop && Array.isArray(j?.holders)) setHolders(j.holders as Holder[]);
      } catch {}
    }
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  /* Ranking + search for Holders */
  const sortedHolders = useMemo(() => {
    return [...holders]
      .filter((h) => !blacklistSet.has(h.wallet.toLowerCase()))
      .sort((a, b) => b.balance - a.balance);
  }, [holders, blacklistSet]);

  const rankMap = useMemo(() => {
    const m = new Map<string, number>();
    sortedHolders.forEach((h, i) => m.set(h.wallet.toLowerCase(), i + 1));
    return m;
  }, [sortedHolders]);

  const [holderQuery, setHolderQuery] = useState("");
  const holderQueryLc = holderQuery.trim().toLowerCase();
  const searchedHolders = useMemo(() => {
    if (!holderQueryLc) return sortedHolders;
    return sortedHolders.filter((h) => h.wallet.toLowerCase().includes(holderQueryLc));
  }, [sortedHolders, holderQueryLc]);

  /* Claim (one-click, no preview modal) */
  const [claiming, setClaiming] = useState(false);
  const [lastClaimAmt, setLastClaimAmt] = useState<number | null>(null);
  const [showShareCard, setShowShareCard] = useState(false);
  const claimCooldownRef = useRef<number>(0); // ms timestamp; prevents spam

  async function handleClaim() {
    if (!connected || !publicKey) {
      showToast("Connect a wallet first.", "error");
      return;
    }
    if (!signTransaction) {
      showToast("Wallet cannot sign transactions.", "error");
      return;
    }

    const nowTs = Date.now();
    if (nowTs < claimCooldownRef.current) {
      showToast("Slow down a sec…", "info");
      return;
    }
    claimCooldownRef.current = nowTs + 10_000; // 10s client cooldown

    setClaiming(true);
    try {
      // Always get a fresh preview (server caches blockhash; low RPC load)
      const fresh = await fetch("/api/claim-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      }).then((r) => r.json());

      const txB64: string | null = fresh?.txBase64 ?? fresh?.txB64 ?? null;
      const amountToClaim: number = typeof fresh?.amount === "number" ? fresh.amount : 0;
      const snapIds: string[] = Array.isArray(fresh?.snapshotIds) ? fresh.snapshotIds : [];

      if (!txB64 || amountToClaim <= 0 || snapIds.length === 0) {
        showToast(fresh?.note || "Nothing to claim right now.", "error");
        return;
      }

      // --- Phantom signs FIRST ---
      const unsignedTx = VersionedTransaction.deserialize(b64ToU8a(txB64));
      const userSigned = await signTransaction(unsignedTx);
      const signedTxB64 = u8aToB64(userSigned.serialize());

      // Send to server for additional signer + broadcast
      const submit = await fetch("/api/claim-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          signedTxB64,
          unsignedTxB64: txB64,   // ← keep this
          snapshotIds: snapIds,
          amount: amountToClaim,
        }),
      }).then(r => r.json());

      if (!submit?.ok || !submit?.sig) throw new Error(submit?.error || "submit failed");
      const sig = submit.sig as string;

      // Optimistic UI bumps
      setRecent((prev) =>
        [{ wallet: publicKey.toBase58(), amount: amountToClaim, ts: new Date().toISOString(), sig }, ...prev].slice(
          0,
          50
        )
      );
      setTotalDistributedPump((prev) => prev + amountToClaim);

      // Report (idempotent)
      fetch("/api/claim-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          sig,
          snapshotIds: snapIds,
          amount: amountToClaim,
        }),
      }).catch(() => {});

      setLastClaimAmt(amountToClaim);
      setShowShareCard(true);
      showToast("Claim sent! 🎉", "success");
      fireConfetti();

      // Reconcile
      await Promise.all([
        refreshEntitlement(publicKey.toBase58()),
        refreshMetrics(),
        refreshRecent(),
      ]);
    } catch (e) {
      console.error(e);
      showToast("Claim failed. Please try again in a few seconds.", "error");
    } finally {
      setClaiming(false);
    }
  }

  /* Tabs */
  const [tab, setTab] = useState<"holders" | "proofs" | "feed" | "history">("holders");

  /* Holders pagination (10 per page) */
  const pageSize = 10;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(searchedHolders.length / pageSize));
  const pageItems = searchedHolders.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => {
    setPage(1);
  }, [searchedHolders.length]);

  /* Copy CA feedback */
  const [copied, setCopied] = useState(false);
  async function copyCA() {
    try {
      await navigator.clipboard.writeText(COIN_MINT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  /* Share on X (global button) */
  function shareOnX(amountOverride?: number | null) {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://pumpdrop.app";
    const amt =
      (amountOverride ?? lastClaimAmt)
        ? `${(amountOverride ?? lastClaimAmt)!.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP`
        : "my share of $PUMP";
    const text = `YOOO @pumpdotfun airdrop came in early.\n\nJust claimed ${amt} from $PUMPDROP\n\n${origin}`;
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const totalMs = CYCLE_MINUTES * 60 * 1000;
  const progressPct = Math.max(0, Math.min(100, 100 - (msLeft / totalMs) * 100));
  const meLc = publicKey?.toBase58()?.toLowerCase() ?? null;

  const myRank = useMemo(() => {
    const me = publicKey?.toBase58()?.toLowerCase();
    if (!me) return null;
    return rankMap.get(me) ?? null;
  }, [rankMap, publicKey?.toBase58?.()]);

  /* === ADDED: "How it works" modal toggle === */
  const [showHow, setShowHow] = useState(false);

/* === ADDED: Client-side gentle triggers near end of cycle (+ green popup) === */
const didPrepareRef = useRef(false);
const didPreSnapshotRef = useRef(false);
const didZeroRef = useRef(false);


useEffect(() => {
  const secLeft = Math.floor(msLeft / 1000);

// T-120s: warm caches (no secret routes). Keeps site “alive” and POW fresh.
if (
  !didPrepareRef.current &&
  secLeft <= PREP_OFFSET_SECONDS &&
  secLeft > PREP_OFFSET_SECONDS - 2
) {
  didPrepareRef.current = true;

  // Light warm-ups for POW + metrics + recent feed
  Promise.allSettled([refreshProofs(), refreshMetrics(), refreshRecent()]).catch(() => {});

  // Sometimes also refresh holders (~35%) to avoid spam but keep it lively
  if (Math.random() < 0.35) {
    fetch("/api/holders", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => Array.isArray(j?.holders) && setHolders(j.holders))
      .catch(() => {});
  }
}

// T-8s: pre-snapshot refresh (no toast here anymore; we show it at exact T-0)
if (
  !didPreSnapshotRef.current &&
  secLeft <= SNAPSHOT_OFFSET_SECONDS &&
  secLeft > SNAPSHOT_OFFSET_SECONDS - 2
) {
  didPreSnapshotRef.current = true;
  (async () => {
    await Promise.allSettled([refreshProofs(), refreshMetrics(), refreshRecent()]);
    try {
      const j = await fetch("/api/holders", { cache: "no-store" }).then((r) => r.json());
      if (Array.isArray(j?.holders)) setHolders(j.holders);
    } catch {}
  })();
}

// T-0: final refresh at boundary + show green toast
if (!didZeroRef.current && secLeft <= 1) {
  didZeroRef.current = true;
  (async () => {
    await Promise.allSettled([refreshProofs(), refreshMetrics(), refreshRecent()]);
    try {
      const j = await fetch("/api/holders", { cache: "no-store" }).then((r) => r.json());
      if (Array.isArray(j?.holders)) setHolders(j.holders);
    } catch {}
    showToast("New drop is ready — claim your $PUMP!", "success");
  })();
}

// Reset flags right after boundary
if (secLeft <= 0) {
  didPrepareRef.current = false;
  didPreSnapshotRef.current = false;
  didZeroRef.current = false;
}


  // Reset flags right after boundary
  if (secLeft <= 0) {
    didPrepareRef.current = false;
    didPreSnapshotRef.current = false;
  }
}, [msLeft, blacklistSet]);


  /* === ADDED: tiny post-boundary reconciliation (belt & suspenders) === */
  const lastBoundaryRef = useRef<number>(targetTs.getTime());
  useEffect(() => {
    const cur = targetTs.getTime();
    if (cur !== lastBoundaryRef.current) {
      lastBoundaryRef.current = cur;
      // Small delayed refresh in case users arrived late to page
      const t = setTimeout(() => {
        Promise.allSettled([refreshMetrics(), refreshRecent(), refreshProofs()]).then(() => {
          fetch("/api/holders", { cache: "no-store" })
            .then((r) => r.json())
            .then((j) => Array.isArray(j?.holders) && setHolders(j.holders))
            .catch(() => {});
        });
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [targetTs]);

  return (
    <div className="min-h-screen relative">
      <div className="grid-overlay" />
      <div className="grid-vignette" />

      {/* Header */}
      <header className="relative z-[10000] flex items-center justify-between px-5 py-4 max-w-6xl mx-auto">
        <div className="w-56">
          <ConnectButton />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <div className="opacity-70">CA</div>
          <div className="font-mono rounded-lg px-3 py-1.5 bg-[#141419] border border-[#262630]">
            {formatMintForHeader(COIN_MINT)}
          </div>
          <button
            onClick={copyCA}
            className="relative text-xs px-2 py-1 rounded-md border border-[#2a2a33] bg-[#111118] hover:bg-[#16161c]"
            title="Copy CA"
          >
            Copy
            {copied && (
              <span className="absolute -right-2 -top-3 text-[10px] rounded-md px-2 py-0.5 bg-[var(--accent)] text-black shadow">
                Copied!
              </span>
            )}
          </button>
        </div>
        <div className="relative w-56 flex justify-end gap-2">
          <a
            href="https://x.com/pumpdropapp"
            target="_blank"
            rel="noreferrer"
            className="px-4 py-2 rounded-xl border border-[#2a2a33] bg-[#111118] hover:bg-[#16161c] text-sm inline-flex items-center gap-2"
            title="Follow on X"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M18.9 3H22l-7.7 8.8L22.8 21H17l-5-6l-5.6 6H2.3l8.4-9.2L2 3h5.1l4.5 5.4L18.9 3z" />
            </svg>
          </a>

          {/* === ADDED: How it works button (top-right) === */}
          <button
            onClick={() => setShowHow(true)}
            className="wiggle-2s px-4 py-2 rounded-xl border border-[#2a2a33] bg-[#111118] hover:bg-[#16161c] text-sm"
            title="How it works"
          >
            How it works
          </button>

          {/* Wallets overlay */}
          <div className="absolute right-0 top-full mt-2 w-56 z-50">
            <WalletStrip />
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="relative z-10 max-w-6xl mx-auto px-5">
        {/* Toast */}
        <div
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 z-[9997] mt-2"
          style={{ top: "72px" }}
        >
          <AnimatePresence>
            {toast && (
              <div className="pointer-events-auto">
                <Toast msg={toast.msg} type={toast.type} />
              </div>
            )}
          </AnimatePresence>
        </div>

        {/* HERO */}
        <section className="py-4 sm:py-8 flex flex-col items-center text-center gap-4">
          <div className="relative w-full max-w-xl">
            <div className="relative h-4 sm:h-5 rounded-full bg-neutral-800 overflow-hidden border border-white/10">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${progressPct}%`,
                  background: `linear-gradient(90deg, #00FFC2, #00FFC2)`,
                  boxShadow: `0 0 16px #00FFC2`,
                }}
              >
                <div className="absolute inset-0 animate-[shimmer_2s_linear_infinite]" />
              </div>
            </div>
            <div className="mt-3 flex justify-center font-mono text-3xl sm:text-4xl font-bold tracking-wider text-[#00FFC2] drop-shadow-[0_0_12px_#00FFC2]">
              {String(Math.max(0, Math.min(99, Math.floor(msLeft / 60000)))).padStart(2, "0")}
              <span className="mx-1 animate-[blink_1s_infinite]">:</span>
              {String(Math.floor((msLeft % 60000) / 1000)).padStart(2, "0")}
            </div>
            <style jsx>{`
              @keyframes shimmer {
                0% {
                  transform: translateX(-100%);
                  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
                }
                100% {
                  transform: translateX(100%);
                  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
                }
              }
              @keyframes blink {
                50% {
                  opacity: 0.3;
                }
              }
            `}</style>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-4xl mt-3">
            <div className="card">
              <div className="badge">Total $PUMP Distributed</div>
              <div className="text-2xl font-semibold mt-1">
                {totalDistributedPump.toLocaleString(undefined, { maximumFractionDigits: 6 })}
              </div>
            </div>

            <div className="card">
              <div className="badge">$PUMP</div>
              <div className="text-2xl font-semibold mt-1 flex items-center gap-2">
                <span>
                  {pumpPrice ? `$${pumpPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : "—"}
                </span>
                <span className={`flex items-center gap-1 text-sm ${isUp ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                  {isUp ? (
                    <svg width="12" height="12" viewBox="0 0 24 24">
                      <path fill="currentColor" d="M12 4l7 8h-4v8H9v-8H5z" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24">
                      <path fill="currentColor" d="M12 20l-7-8h4V4h6v8h4z" />
                    </svg>
                  )}
                  {(pumpChangePct >= 0 ? "+" : "") + pumpChangePct.toFixed(2) + "%"}
                </span>
              </div>
            </div>

            <div className="card">
              <div className="badge">Total Value Distributed</div>
              <div className="text-2xl font-semibold mt-1">{formatUSD(totalUsd)}</div>
            </div>
          </div>

          {/* Claim + Share */}
          <div className="mt-3 flex flex-col items-center gap-3 w-full max-w-xl">
            <button
              onClick={handleClaim}
              disabled={!connected || claiming}
              className={`btn-claim w-full ${!connected || claiming ? "disabled" : "pulse"}`}
              title={connected ? "Claim your $PUMP" : "Connect wallet first"}
            >
              {connected ? (claiming ? "Claiming…" : "CLAIM $PUMP") : "Connect Wallet to Claim"}
            </button>

            {connected && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full">
                <div className="rounded-xl p-3 border border-[#2a2a33] bg-[#111118]">
                  <div className="text-xs opacity-70">Claimable now</div>
                  <div className="text-lg font-semibold">
                    {unclaimed.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP
                  </div>
                </div>
                <div className="rounded-xl p-3 border border-[#2a2a33] bg-[#111118]">
                  <div className="text-xs opacity-70">Claimed total</div>
                  <div className="text-lg font-semibold">
                    {claimed.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP
                  </div>
                </div>
                <div className="rounded-xl p-3 border border-[#2a2a33] bg-[#111118]">
                  <div className="text-xs opacity-70">Total earned (all-time)</div>
                  <div className="text-lg font-semibold">{formatUSD(entitled * pumpPrice)}</div>
                  <div className="text-xs opacity-60 mt-1">
                    ({entitled.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP)
                  </div>
                </div>
              </div>
            )}

            {connected && myRank && (
              <div className="text-xs opacity-80 mt-1">
                Your rank: <span className="font-semibold">#{myRank}</span>
              </div>
            )}
          </div>
        </section>

        {/* Tabs */}
        <div className="flex items-center gap-2 mb-6">
          <button
            onClick={() => setTab("holders")}
            className={`px-3 py-1.5 rounded-lg text-xs ${tab === "holders" ? "bg-[#222]" : "bg-[#17171d] border border-[#24242f]"}`}
          >
            Holders
          </button>
          <button
            onClick={() => setTab("proofs")}
            className={`px-3 py-1.5 rounded-lg text-xs ${tab === "proofs" ? "bg-[#222]" : "bg-[#17171d] border border-[#24242f]"}`}
          >
            POW
          </button>
          <button
            onClick={() => setTab("feed")}
            className={`px-3 py-1.5 rounded-lg text-xs ${tab === "feed" ? "bg-[#222]" : "bg-[#17171d] border border-[#24242f]"}`}
          >
            Feed
          </button>
          <button
            onClick={() => setTab("history")}
            className={`px-3 py-1.5 rounded-lg text-xs ${tab === "history" ? "bg-[#222]" : "bg-[#17171d] border border-[#24242f]"}`}
          >
            My History
          </button>
        </div>

        {/* Holders */}
        {tab === "holders" && (
          <section className="card mb-12">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Holders (&gt; 10,000 $PUMPDROP) — AMM/LP excluded</h3>
              <input
                value={holderQuery}
                onChange={(e) => setHolderQuery(e.target.value)}
                placeholder="Search wallet…"
                className="px-3 py-1.5 rounded-md bg-[#101017] border border-[#24242f] text-sm w-64"
              />
            </div>

            <div className="max-h-[420px] overflow-auto rounded-lg border border-[#2a2a33]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left bg-[#13131a]">
                    <th className="px-3 py-2 font-medium opacity-80">#</th>
                    <th className="px-3 py-2 font-medium opacity-80">Wallet</th>
                    <th className="px-3 py-2 font-medium opacity-80">Holding</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((h, i) => {
                    const addrDisplay = h.display ?? h.wallet;
                    const globalIdx = (page - 1) * pageSize + i;
                    const rank = rankMap.get(h.wallet.toLowerCase()) ?? globalIdx + 1;
                    return (
                      <tr key={`${h.wallet}-${i}`} className="border-t border-[#222]">
                        <td className="px-3 py-2 w-12">#{rank}</td>
                        <td className="px-3 py-2 font-mono">
                          <span>{addrDisplay}</span>
                          {meLc && meLc === (h.wallet?.toLowerCase?.() ?? "") && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-md border border-yellow-500/40 text-yellow-300 bg-yellow-500/10">
                              YOU
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {h.balance.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                        </td>
                        <td className="px-3 py-2 text-right w-[110px]">
                          <SolscanBtn value={addrDisplay} />
                        </td>
                      </tr>
                    );
                  })}
                  {pageItems.length === 0 && (
                    <tr>
                      <td className="px-3 py-3 opacity-60" colSpan={4}>
                        No holders yet for this view.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between mt-4">
              <div className="text-xs opacity-70">
                Page {page} / {totalPages}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 rounded-md bg-[#101017] border border-[#24242f] disabled:opacity-50"
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 rounded-md bg-[#101017] border border-[#24242f] disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          </section>
        )}

        {/* POW */}
        {tab === "proofs" && (
          <section className="card mb-12">
            <h3 className="font-semibold mb-3">On-chain Proof Of Work</h3>

            {/* Latest snapshot core fields */}
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg p-3 bg-[#101017] border border-[#24242f]">
                <div className="opacity-60 text-xs">Latest Snapshot ID</div>
                <div className="font-mono break-all">{snapshotId || proofs?.snapshotId || "—"}</div>
              </div>
              <div className="rounded-lg p-3 bg-[#101017] border border-[#24242f]">
                <div className="opacity-60 text-xs">Snapshot Time</div>
                <div>{snapshotTs ? new Date(snapshotTs).toLocaleString() : (proofs?.snapshotTs || "—")}</div>
              </div>

              <div className="rounded-lg p-3 bg-[#101017] border border-[#24242f]">
                <div className="opacity-60 text-xs">Snapshot Hash</div>
                <div className="font-mono break-all">{proofs?.snapshotHash || "—"}</div>
              </div>

              <div className="rounded-lg p-3 bg-[#101017] border border-[#24242f]">
                <div className="opacity-60 text-xs">Delta $PUMP (allocated this cycle)</div>
                <div>{(proofs?.pumpBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}</div>
              </div>
            </div>

            {/* Tx evidence cards */}
            <div className="grid sm:grid-cols-2 gap-3 mt-3 text-sm">
              <div className="rounded-lg p-3 bg-[#101017] border border-[#24242f] flex items-center justify-between">
                <div>
                  <div className="opacity-60 text-xs">Creator rewards (SOL, this cycle)</div>
                  <div className="font-semibold">
                    {(proofs?.creatorSol || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL
                  </div>
                </div>
                {proofs?.txs?.claimSig ? (
                  <a
                    className="text-xs underline opacity-80"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://solscan.io/tx/${proofs.txs.claimSig}`}
                  >
                    View on Solscan
                  </a>
                ) : (
                  <span className="text-xs opacity-50">—</span>
                )}
              </div>

              <div className="rounded-lg p-3 bg-[#101017] border border-[#24242f] flex items-center justify-between">
                <div>
                  <div className="opacity-60 text-xs">$PUMP swapped (this cycle)</div>
                  <div className="font-semibold">
                    {(proofs?.pumpSwapped || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP
                  </div>
                </div>
                {proofs?.txs?.swapSig ? (
                  <a
                    className="text-xs underline opacity-80"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://solscan.io/tx/${proofs.txs.swapSig}`}
                  >
                    View on Solscan
                  </a>
                ) : (
                  <span className="text-xs opacity-50">—</span>
                )}
              </div>
            </div>

            {/* Previous snapshots (foldable, no React state) */}
            <div className="mt-5">
              <details className="group rounded-lg">
                <summary className="cursor-pointer px-3 py-2 rounded-lg text-xs bg-[#17171d] border border-[#24242f]">
                  <span className="group-open:hidden">Show previous snapshots</span>
                  <span className="hidden group-open:inline">Hide previous snapshots</span>
                </summary>

                <div className="mt-3 space-y-2">
                  {(proofs?.previous ?? []).length === 0 && (
                    <div className="opacity-60 text-sm">No previous snapshots yet.</div>
                  )}

                  {(proofs?.previous ?? []).map((p: any, idx: number) => (
                    <details key={p.snapshotId || idx} className="group rounded-lg bg-[#101017] border border-[#24242f]">
                      <summary className="cursor-pointer px-3 py-2 text-sm flex items-center justify-between">
                        <span className="font-mono">
                          {p.snapshotTs ? new Date(p.snapshotTs).toLocaleString() : "—"} · {p.snapshotId || "—"}
                        </span>
                        <span className="opacity-60 text-xs group-open:hidden">Click to expand</span>
                        <span className="opacity-60 text-xs hidden group-open:inline">Click to collapse</span>
                      </summary>

                      <div className="px-3 pb-3 grid sm:grid-cols-2 gap-3 text-sm">
                        <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f]">
                          <div className="opacity-60 text-xs">Snapshot Hash</div>
                          <div className="font-mono break-all">{p.snapshotHash || p.holdersHash || "—"}</div>
                        </div>
                        <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f]">
                          <div className="opacity-60 text-xs">Delta $PUMP (allocated)</div>
                          <div>{(p.pumpBalance ?? p.deltaPump ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}</div>
                        </div>

                        <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                          <div>
                            <div className="opacity-60 text-xs">Creator rewards (SOL)</div>
                            <div className="font-semibold">
                              {(p.creatorSol || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL
                            </div>
                          </div>
                          {p?.txs?.claimSig ? (
                            <a
                              className="text-xs underline opacity-80"
                              target="_blank"
                              rel="noreferrer"
                              href={`https://solscan.io/tx/${p.txs.claimSig}`}
                            >
                              Solscan
                            </a>
                          ) : (
                            <span className="text-xs opacity-50">—</span>
                          )}
                        </div>

                        <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                          <div>
                            <div className="opacity-60 text-xs">$PUMP swapped</div>
                            <div className="font-semibold">
                              {(p.pumpSwapped || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP
                            </div>
                          </div>
                          {p?.txs?.swapSig ? (
                            <a
                              className="text-xs underline opacity-80"
                              target="_blank"
                              rel="noreferrer"
                              href={`https://solscan.io/tx/${p.txs.swapSig}`}
                            >
                              Solscan
                            </a>
                          ) : (
                            <span className="text-xs opacity-50">—</span>
                          )}
                        </div>

                        {/* CSV download if present */}
                        {p.csv ? (
                          <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                            <div className="opacity-60 text-xs">Snapshot holders CSV</div>
                            <a className="text-xs underline opacity-80" href={p.csv}>
                              Download
                            </a>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            </div>
          </section>
        )}

        {/* Feed */}
        {tab === "feed" && (
          <section className="card mb-12">
            <h3 className="font-semibold mb-3">Recent Claims</h3>

            <div className="space-y-2">
              <AnimatePresence initial={false}>
                {recent.map((c, i) => (
                  <motion.div
                    key={c.sig || `${c.wallet}-${c.ts}-${i}`}
                    layout
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={{ duration: 0.18 }}
                    className="flex items-center justify-between rounded-lg px-3 py-2 bg-[#101017] border border-[#24242f] text-sm"
                  >
                    <div className="font-mono flex items-center gap-2">
                      {short(c.wallet)}
                      {connected && publicKey?.toBase58()?.toLowerCase() === c.wallet.toLowerCase() && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md border border-yellow-500/40 text-yellow-300 bg-yellow-500/10">
                          YOU
                        </span>
                      )}
                    </div>

                    <div className="tabular-nums">
                      {c.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP
                    </div>
                    <div className="opacity-70 text-xs w-20 text-right">{timeAgo(c.ts, now)}</div>
                    <a
                      className="ml-3 px-2 py-1 rounded-md border border-[#2a2a33] bg-[#0c0c12] hover:bg-[#14141b] text-xs"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://solscan.io/tx/${c.sig}`}
                      title="View on Solscan"
                    >
                      Solscan
                    </a>
                  </motion.div>
                ))}
              </AnimatePresence>

              {recent.length === 0 && <div className="opacity-60 text-sm">No claims yet.</div>}
            </div>
          </section>
        )}

        {/* My History */}
        {tab === "history" && (
          <section className="card mb-12">
            <h3 className="font-semibold mb-3">Your Claim History</h3>
            {!connected ? (
              <div className="opacity-60 text-sm">Connect a wallet to view your history.</div>
            ) : (
              <div className="space-y-2">
                {myHistory.map((c, i) => (
                  <div
                    key={c.sig || i}
                    className="flex items-center justify-between rounded-lg px-3 py-2 bg-[#101017] border border-[#24242f] text-sm"
                  >
                    <div className="tabular-nums">
                      {c.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP
                    </div>
                    <div className="opacity-70 text-xs">{new Date(c.ts).toLocaleString()}</div>
                    <a
                      className="ml-3 px-2 py-1 rounded-md border border-[#2a2a33] bg-[#0c0c12] hover:bg-[#14141b] text-xs"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://solscan.io/tx/${c.sig}`}
                      title="View on Solscan"
                    >
                      Solscan
                    </a>
                  </div>
                ))}
                {myHistory.length === 0 && (
                  <div className="opacity-60 text-sm">
                    No claims found for this wallet (last 50 global claims scanned).
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* 🎉 Post-claim Share Card */}
        {showShareCard && lastClaimAmt !== null && (
          <div className="fixed left-4 bottom-4 z-[9998]">
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.98 }}
              className="rounded-2xl p-4 bg-[#101017] border border-[#24242f] shadow-lg w=[min(420px,92vw)]"
            >
              <div className="text-sm opacity-80">Nice! You just claimed</div>
              <div className="text-2xl font-semibold mt-1">
                {lastClaimAmt.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP
              </div>
              <div className="mt-3 flex gap-2 justify-end">
                <button
                  onClick={() => setShowShareCard(false)}
                  className="px-3 py-1.5 rounded-lg bg-[#17171d] border border-[#24242f] text-sm"
                >
                  Close
                </button>
                <button
                  onClick={() => shareOnX(lastClaimAmt)}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{ background: "var(--accent)", color: "#061915" }}
                >
                  Share on X
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {/* === ADDED: How it works modal === */}
        {showHow && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]">
            <div
              className="rounded-2xl p-5 w-[min(720px,92vw)] max-h-[82vh] overflow-auto"
              style={{ background: "var(--panel)", border: "1px solid #333" }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-lg">How it works</div>
                <button
                  onClick={() => setShowHow(false)}
                  className="px-3 py-1 rounded-md"
                  style={{ background: "#2a2a33" }}
                >
                  Close
                </button>
              </div>
              <div className="space-y-3 text-sm leading-6 opacity-95 text-left">
                <p className="leading-6">
                  <b>PUMPDROP</b> is{" "}
                  <span className="text-[var(--accent)] font-semibold animate-pulse">fully automated</span> — every 10
                  minutes it automatically collects creator rewards, swaps to <b>$PUMP</b>, and fairly splits them to all
                  eligible holders (&gt; 10,000 $PUMPDROP). No staking, no forms, no manual distribution — just connect
                  and claim.
                </p>
                <ol className="list-decimal pl-5 space-y-2">
                  <li>
                    <b>Cycle basics.</b> A new drop happens every {CYCLE_MINUTES} minutes. The countdown bar shows the
                    next distribution window.
                  </li>

                  <li>
                    <b>Eligibility snapshot.</b> Moments before the timer ends (about {SNAPSHOT_OFFSET_SECONDS}s), we
                    snapshot holders of <b>&gt; 10,000 $PUMPDROP</b>. AMM/LP and any blacklisted addresses are
                    excluded to keep it fair.
                    <ul className="mt-1 list-disc pl-5 space-y-1 opacity-80">
                      <li>Your wallet balance at snapshot time determines eligibility for that cycle.</li>
                      <li>No staking or LP position required—just hold the tokens in your wallet.</li>
                    </ul>
                  </li>

                  <li>
                    <b>Allocation math.</b> The $PUMP collected for the cycle is split evenly across all eligible
                    wallets. Your “Claimable now” card shows the exact amount available to you.
                  </li>

                  <li>
                    <b>Claiming.</b> Connect your wallet and press <b>CLAIM $PUMP</b>. You’ll sign a single transaction
                    and receive tokens instantly.
                    <ul className="mt-1 list-disc pl-5 space-y-1 opacity-80">
                      <li>If your $PUMP token account (ATA) doesn’t exist, the transaction creates it automatically.</li>
                      <li>Standard Solana fees apply.</li>
                    </ul>
                  </li>

                  <li>
                    <b>Unclaimed rollovers.</b> If you miss a cycle, your allocation stays available. Each new cycle
                    only uses fresh $PUMP—previous entitlements remain claimable.
                  </li>

                  <li>
                    <b>Proof &amp; transparency.</b> The <b>POW</b> tab publishes the snapshot ID, hash, and on-chain
                    transactions (with Solscan links) for creator rewards, swaps, and distributions.
                  </li>

                  <li>
                    <b>Your history.</b> Connect your wallet to see a private <b>My History</b> list of your claims.
                  </li>

                  <li className="leading-6">
                    <b className="text-red-500 animate-pulse">Safety.</b> We never ask for approvals or spending
                    permissions—just a one-time claim transaction signed by you.{" "}
                    <span className="text-red-500 font-semibold">Always verify details before signing.</span>
                  </li>
                </ol>

                <div className="text-xs opacity-50">
                  <p>*10% of creator rewards are allocated to the development team.</p>
                  <p className="mt-1">*Each claim includes a 0.01 SOL fee to support app operations and future features.</p>
                  <p className="mt-1">*The Pumpdrop program runs continuously, 24/7, powered by in-house smart contracts.</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="relative z-10 text-center text-xs opacity-60 pb-10 pt-6">
        © 2025 PUMPDROP · All rights reserved.
      </footer>
    </div>
  );
}

/* Prev snapshots section (collapsible content) */
function PrevSnapshots({ proofs }: { proofs: any }) {
  const [showPrev, setShowPrev] = useState(false);
  useEffect(() => {
    setShowPrev(false);
  }, [proofs?.snapshotId]);
  if (!proofs) return null;
  return (
    <>
      <button
        onClick={() => setShowPrev((v) => !v)}
        className="mt-3 px-3 py-2 rounded-lg text-xs bg-[#17171d] border border-[#24242f]"
      >
        {showPrev ? "Hide previous snapshots" : "Show previous snapshots"}
      </button>
      {showPrev && (
        <div className="mt-3 space-y-2">
          {(proofs?.previous ?? []).length === 0 && (
            <div className="opacity-60 text-sm">No previous snapshots yet.</div>
          )}
          {(proofs?.previous ?? []).map((p: any, idx: number) => (
            <details key={p.snapshotId || idx} className="group rounded-lg bg-[#101017] border border-[#24242f]">
              <summary className="cursor-pointer px-3 py-2 text-sm flex items-center justify-between">
                <span className="font-mono">
                  {p.snapshotTs ? new Date(p.snapshotTs).toLocaleString() : "—"} · {p.snapshotId || "—"}
                </span>
                <span className="opacity-60 text-xs group-open:hidden">Click to expand</span>
                <span className="opacity-60 text-xs hidden group-open:inline">Click to collapse</span>
              </summary>

              <div className="px-3 pb-3 grid sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f]">
                  <div className="opacity-60 text-xs">Snapshot Hash</div>
                  <div className="font-mono break-all">{p.snapshotHash || p.holdersHash || "—"}</div>
                </div>
                <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f]">
                  <div className="opacity-60 text-xs">Delta $PUMP (allocated)</div>
                  <div>
                    {(p.pumpBalance ?? p.deltaPump ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </div>
                </div>

                <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                  <div>
                    <div className="opacity-60 text-xs">Creator rewards (SOL)</div>
                    <div className="font-semibold">
                      {(p.creatorSol || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL
                    </div>
                  </div>
                  {p?.txs?.claimSig ? (
                    <a
                      className="text-xs underline opacity-80"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://solscan.io/tx/${p.txs.claimSig}`}
                    >
                      Solscan
                    </a>
                  ) : (
                    <span className="text-xs opacity-50">—</span>
                  )}
                </div>

                <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                  <div>
                    <div className="opacity-60 text-xs">$PUMP swapped</div>
                    <div className="font-semibold">
                      {(p.pumpSwapped || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP
                    </div>
                  </div>
                  {p?.txs?.swapSig ? (
                    <a
                      className="text-xs underline opacity-80"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://solscan.io/tx/${p.txs.swapSig}`}
                    >
                      Solscan
                    </a>
                  ) : (
                    <span className="text-xs opacity-50">—</span>
                  )}
                </div>

                {p.csv ? (
                  <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                    <div className="opacity-60 text-xs">Snapshot holders CSV</div>
                    <a className="text-xs underline opacity-80" href={p.csv}>
                      Download
                    </a>
                  </div>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

/* Solscan button */
function SolscanBtn({ value }: { value: string }) {
  const [isActive, setIsActive] = useState(false);
  return (
    <a
      href={`https://solscan.io/account/${value}`}
      target="_blank"
      rel="noreferrer"
      onClick={() => {
        setIsActive(true);
        setTimeout(() => setIsActive(false), 4000);
      }}
      className={`text-xs px-2 py-1 rounded border transition-all duration-200 inline-block text-center
        ${
          isActive
            ? "bg-red-600 text-white border-transparent shadow scale-[0.98]"
            : "bg-[#101017] border-[#24242f] hover:bg-[#15151d] active:scale-95"
        }`}
      style={{ width: 82 }}
      title="Open on Solscan"
    >
      {isActive ? "Opened!" : "Solscan"}
    </a>
  );
}

/* Wallet copy strip */
function WalletCopyRow({ label, addr }: { label: string; addr: string }) {
  const [copied, setCopied] = useState(false);
  async function writeClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }
  async function onCopy() {
    const ok = await writeClipboard(addr);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 bg-[#101017] border border-[#24242f]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[#17171d] border border-[#2a2a33] tracking-wide">
          {label}
        </span>
        <span className="font-mono text-xs truncate">{short(addr, 6, 6)}</span>
      </div>
      <button
        type="button"
        onClick={onCopy}
        className={`text-[11px] px-2 py-1 rounded-md border transition-all active:scale-95 ${
          copied ? "border-transparent shadow" : "bg-[#0c0c12] border-[#2a2a33] hover:bg-[#14141b]"
        }`}
        style={copied ? { background: "#00FFC2", color: "#061915" } : undefined}
        title="Copy address"
        aria-live="polite"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

function WalletStrip() {
  return (
    <div className="w-56 space-y-1 pointer-events-auto">
      <WalletCopyRow label="DEV" addr="2FgpebF7Ms8gHPx4RrqgXxDkLMGn7jPn8uv4Q7AbgaMB" />
      <WalletCopyRow label="TREASURY" addr="Hqk72pLgP6h2b2dkLi4YuPXnWddc6hux9p3M82YpfbJG" />
      <WalletCopyRow label="TEAM" addr="6vYrrqc4Rsj7QhaTY1HN3YRpRmwP5TEq9zss5HKyd5fh" />
    </div>
  );
}

/* === App wrapper === */
export default function Page() {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <InnerApp />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}





