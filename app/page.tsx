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

/* === ENV === */
const COIN_MINT = process.env.NEXT_PUBLIC_COIN_MINT || "<SET_YOUR_COIN_MINT>";
const TREASURY = process.env.NEXT_PUBLIC_TREASURY || "<SET_TREASURY_WALLET_PUBKEY>";
const FEE_WALLET = process.env.NEXT_PUBLIC_FEE_WALLET || "6vYrrqc4Rsj7QhaTY1HN3YRpRmwP5TEq9zss5HKyd5fh";
const ENV_BLACKLIST = process.env.NEXT_PUBLIC_BLACKLIST || ""; // comma-separated
const PUMPFUN_AMM = process.env.NEXT_PUBLIC_PUMPFUN_AMM || ""; // single wallet
const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const PREP_OFFSET_SECONDS = Number(process.env.PREP_OFFSET_SECONDS || 120);
const SNAPSHOT_OFFSET_SECONDS = Number(process.env.SNAPSHOT_OFFSET_SECONDS || 8);
const RPC_ENDPOINT =
  process.env.NEXT_PUBLIC_SOLANA_RPC ||
  process.env.SOLANA_RPC ||
  "https://api.mainnet-beta.solana.com";

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
  // chunk to avoid call stack overflow
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
  if (!mint || mint.length < 8) return "----.----";
  return `${mint.slice(0, 4)}.${mint.slice(-4)}`;
}

/* Relative time helper for feed/history */
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
    type === "success" ? "bg-emerald-600 border-emerald-400" :
    type === "error" ? "bg-red-600 border-red-400" :
    "bg-[#222] border-[#2a2a33]";
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

/* === Wallet Button (with Disconnect) — single line, no-wrap === */
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
          {/* small power icon */}
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
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  /* Toast state */
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(null);
  const showToast = (msg: string, type: ToastType = "info", ms = 3000) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), ms);
  };

  /* Countdown */
  const [targetTs, setTargetTs] = useState<Date>(() => nextBoundary(CYCLE_MINUTES));
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  let msLeft = Math.max(0, +targetTs - +now);
  if (msLeft <= 0) {
    const newTarget = nextBoundary(CYCLE_MINUTES, new Date(+now + 1000));
    if (newTarget.getTime() !== targetTs.getTime()) {
      setTargetTs(newTarget);
      msLeft = Math.max(0, +newTarget - +now);
    }
  }
// === Post-cycle refresh + toast (worker-friendly) ===
const didPostCycleRef = useRef(false);
useEffect(() => {
  const secLeft = Math.floor(msLeft / 1000);

  // Fire once right as the countdown flips to the next window
  if (!didPostCycleRef.current && secLeft === 0) {
    didPostCycleRef.current = true;

    // Let the worker finish writing snapshot/prep, then refresh UI
    setTimeout(() => {
      refreshProofs();
      refreshMetrics();
      refreshRecent();
      if (publicKey) refreshEntitlement(publicKey.toBase58());
      showToast("Cycle completed! New drop is live ✅", "success", 2500);
    }, 1200);

    // Unlock for the next cycle
    setTimeout(() => { didPostCycleRef.current = false; }, 4000);
  }
}, [msLeft, publicKey?.toBase58?.()]);

  /* Snapshot + holders state */
  const [holders, setHolders] = useState<Holder[]>([]);
  const [eligible, setEligible] = useState<Holder[]>([]);
  const [pumpBalance, setPumpBalance] = useState(0);
  const [perHolder, setPerHolder] = useState(0);
  const [snapshotTs, setSnapshotTs] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [pendingSnapshotIds, setPendingSnapshotIds] = useState<string[]>([]);

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
  useEffect(() => { refreshMetrics(); }, []);

  // 🔁 Poll metrics every 10s so Total Distributed and Value update live
  useEffect(() => {
    const id = setInterval(() => {
      refreshMetrics();
    }, 10000);
    return () => clearInterval(id);
  }, []);

  /* Recent claims feed */
  const [recent, setRecent] = useState<RecentClaim[]>([]);
 async function refreshRecent() {
  try {
    const r = await fetch("/api/recent-claims", { cache: "no-store" }).then(r => r.json());
    const arr = Array.isArray(r) ? r.slice(0, 50) : [];
    const seen = new Set<string>();
    const deduped: RecentClaim[] = [];
    for (const x of arr) {
      const k = x?.sig || `${x?.wallet}-${x?.ts}`;
      if (!seen.has(k)) { seen.add(k); deduped.push(x); }
    }
    setRecent(deduped);
  } catch {}
}

  useEffect(() => { refreshRecent(); }, []);

  // 🔁 Poll recent claims every 5 seconds so everyone sees updates
  useEffect(() => {
    const id = setInterval(() => {
      refreshRecent();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  /* History (derived from recent for the connected wallet) */
  const myHistory = useMemo(() => {
    const me = publicKey?.toBase58();
    if (!me) return [];
    return recent.filter(rc => rc.wallet?.toLowerCase() === me.toLowerCase());
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
      setEntitled(d.entitled || 0); setClaimed(d.claimed || 0); setUnclaimed(d.unclaimed || 0);
    } catch {}
  }
  useEffect(() => {
    if (publicKey) {
      const pk = publicKey.toBase58();
      refreshEntitlement(pk);
    }
  }, [publicKey?.toBase58?.(), perHolder, eligible.length, snapshotId]);

  /* Proofs data */
  const [proofs, setProofs] = useState<any>(null);
  async function refreshProofs() { try { const p = await fetch("/api/proofs").then(r => r.json()); setProofs(p || null); } catch {} }
  useEffect(() => { refreshProofs(); }, []);
  const [showPrev, setShowPrev] = useState(false);

  /* How it works modal */
  const [showHow, setShowHow] = useState(false);

  /* 🔁 Poll holders list every 10s from server cache */
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const res = await fetch("/api/holders", { cache: "no-store" });
        const j = await res.json();
        if (!stop && Array.isArray(j?.holders)) {
          setHolders(j.holders as Holder[]);
        }
      } catch {}
    }
    tick();
    const id = setInterval(tick, 10_000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  /* Ranking + search for Holders */
  const sortedHolders = useMemo(() => {
    return [...holders]
      .filter(h => !blacklistSet.has(h.wallet.toLowerCase()))
      .sort((a, b) => (b.balance - a.balance));
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
    return sortedHolders.filter(h => h.wallet.toLowerCase().includes(holderQueryLc));
  }, [sortedHolders, holderQueryLc]);

  /* Claim preview + actions */
  const [claiming, setClaiming] = useState(false);
  const [preview, setPreview] = useState<{ amount?: number; feeSol?: number; txBase64?: string; snapshotIds?: string[] } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [lastClaimAmt, setLastClaimAmt] = useState<number | null>(null);
  const [showShareCard, setShowShareCard] = useState(false);

  async function openClaimPreview() {
    if (!connected || !publicKey) {
      showToast("Connect a wallet first.", "error");
      return;
    }
    try {
      const pk = publicKey.toBase58();
      const out = await fetch("/api/claim-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: pk })
      }).then(r => r.json());

      const txBase64 = out?.txBase64 || out?.txB64; // accept either field name

      if (!txBase64) {
        showToast(out?.note || "No unclaimed $PUMP.", "error");
        return;
      }

      setPreview({
        txBase64,
        amount: typeof out?.amount === "number" ? out.amount : 0,
        feeSol: typeof out?.feeSol === "number" ? out.feeSol : 0.01,
        snapshotIds: Array.isArray(out?.snapshotIds) ? out.snapshotIds : [],
      });
      setPendingSnapshotIds(Array.isArray(out?.snapshotIds) ? out.snapshotIds : []);
      setShowPreview(true);
    } catch (e) {
      console.error(e);
      showToast("Couldn’t prepare your claim. Try again in a moment.", "error");
    }
  }

  async function confirmAndClaim() {
    try {
      if (!connected || !publicKey) return;
      if (!signTransaction) {
        showToast("Wallet cannot sign transactions.", "error");
        return;
      }
      setClaiming(true);

      // Always refresh preview to avoid stale blockhash/amount
      const fresh = await fetch("/api/claim-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() })
      }).then(r => r.json());

      const txB64: string | null = fresh?.txBase64 ?? fresh?.txB64 ?? preview?.txBase64 ?? null;
      const amountToClaim: number = typeof fresh?.amount === "number" ? fresh.amount : (preview?.amount ?? 0);

      const snapIds: string[] = Array.isArray(fresh?.snapshotIds)
        ? fresh.snapshotIds
        : (Array.isArray(preview?.snapshotIds) ? (preview!.snapshotIds as string[]) : []);

      if (!txB64 || amountToClaim <= 0) {
        setShowPreview(false);
        setClaiming(false);
        showToast(fresh?.note || "Nothing to claim right now.", "error");
        return;
      }

      // --- Phantom signs FIRST (per Lighthouse requirement) ---
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
          snapshotIds: snapIds,
          amount: amountToClaim,
        }),
      }).then(r => r.json());

      if (!submit?.ok || !submit?.sig) {
        throw new Error(submit?.error || "submit failed");
      }
      const sig = submit.sig as string;

      // Optimistically prepend claim to the feed (instant)
      setRecent(prev => {
  const k = sig;
  if (prev.some(p => p.sig === k)) return prev;
  const next = [{ wallet: publicKey.toBase58(), amount: amountToClaim, ts: new Date().toISOString(), sig }, ...prev];
  const seen = new Set<string>();
  const unique: RecentClaim[] = [];
  for (const x of next) {
    const kk = x.sig || `${x.wallet}-${x.ts}`;
    if (!seen.has(kk)) { seen.add(kk); unique.push(x); }
  }
  return unique.slice(0, 50);
});


      // Optimistically bump Total Distributed
      setTotalDistributedPump(prev => prev + amountToClaim);

      // Close modal and report to backend → metrics + feed aggregator (idempotent)
      setShowPreview(false);
      await fetch("/api/claim-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          sig,
          snapshotIds: snapIds,
          amount: amountToClaim,
        }),
      });

      setLastClaimAmt(amountToClaim);
      setShowShareCard(true);
      showToast("Claim sent! 🎉", "success");

      // Refresh UI from server (reconcile)
      await Promise.all([
        (async () => refreshEntitlement(publicKey.toBase58()))(),
        (async () => refreshMetrics())(),
        (async () => refreshRecent())(),
      ]);

      // confetti
      fireConfetti();

    } catch (e) {
      console.error(e);
      // quick retry with fresh preview
      try {
        const retry = await fetch("/api/claim-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: publicKey!.toBase58() })
        }).then(r => r.json());

        const txB64 = retry?.txBase64 ?? retry?.txB64 ?? null;
        if (txB64 && signTransaction) {
          const unsigned2 = VersionedTransaction.deserialize(b64ToU8a(txB64));
          const userSigned2 = await signTransaction(unsigned2);
          const signedTxB64_2 = u8aToB64(userSigned2.serialize());

          const submit2 = await fetch("/api/claim-submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              wallet: publicKey!.toBase58(),
              signedTxB64: signedTxB64_2,
              snapshotIds: Array.isArray(retry?.snapshotIds) ? retry.snapshotIds : [],
              amount: typeof retry?.amount === "number" ? retry.amount : (preview?.amount ?? 0),
            }),
          }).then(r => r.json());

          if (!submit2?.ok || !submit2?.sig) throw new Error(submit2?.error || "submit failed");
          const sig2 = submit2.sig as string;

          const amt = typeof retry?.amount === "number" ? retry.amount : (preview?.amount ?? 0);

          // Optimistic insert for retry path
          setRecent(prev => {
  const k = sig2;
  if (prev.some(p => p.sig === k)) return prev; // already present
  const next = [
    { wallet: publicKey!.toBase58(), amount: amt, ts: new Date().toISOString(), sig: sig2 },
    ...prev,
  ];
  const seen = new Set<string>();
  const unique: RecentClaim[] = [];
  for (const x of next) {
    const kk = x.sig || `${x.wallet}-${x.ts}`;
    if (!seen.has(kk)) { seen.add(kk); unique.push(x); }
  }
  return unique.slice(0, 50);
});


          setTotalDistributedPump(prev => prev + amt);

          setShowPreview(false);
          await fetch("/api/claim-report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              wallet: publicKey!.toBase58(),
              sig: sig2,
              snapshotIds: Array.isArray(retry?.snapshotIds) ? retry.snapshotIds : [],
              amount: amt,
            }),
          });

          setLastClaimAmt(amt);
          setShowShareCard(true);
          showToast("Claim sent! 🎉", "success");

          await refreshEntitlement(publicKey!.toBase58());
          await refreshMetrics();
          await refreshRecent();
          fireConfetti();
        } else {
          showToast(retry?.note || "Nothing to claim right now.", "error");
        }
      } catch (e2) {
        console.error("claim retry failed:", e2);
        showToast("Claim failed. Please try again in a few seconds.", "error");
      }
    } finally {
      setClaiming(false);
      setPendingSnapshotIds([]);
    }
  }

  /* Tabs */
  const [tab, setTab] = useState<"holders" | "proofs" | "feed" | "history">("holders");

  /* Holders pagination (10 per page) */
  const pageSize = 10;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(searchedHolders.length / pageSize));
  const pageItems = searchedHolders.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(1); }, [searchedHolders.length]);

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
    const amt = (amountOverride ?? lastClaimAmt)
      ? `${(amountOverride ?? lastClaimAmt)!.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP`
      : "my share of $PUMP";
    const text = `YOOO @pumpdotfun airdrop came in early.\n\nJust claimed ${amt} from $PUMPDROP\n\n${origin}`;
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  /* Timer progress % */
  const totalMs = CYCLE_MINUTES * 60 * 1000;
  const progressPct = Math.max(0, Math.min(100, 100 - (msLeft / totalMs) * 100));

  // who am I (lowercased once for cheap comparisons)
  const meLc = publicKey?.toBase58()?.toLowerCase() ?? null;

  /* My rank badge (if visible in the dataset) */
  const myRank = useMemo(() => {
    const me = publicKey?.toBase58()?.toLowerCase();
    if (!me) return null;
    return rankMap.get(me) ?? null;
  }, [rankMap, publicKey?.toBase58?.()]);

  return (
    <div className="min-h-screen relative">
      {/* Animated background */}
      <div className="grid-overlay" />
      <div className="grid-vignette" />

      {/* Header */}
      <header className="relative z-[10000] flex items-center justify-between px-5 py-4 max-w-6xl mx-auto">
        <div className="w-56"><ConnectButton /></div>
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
          <a href="https://x.com/pumpdropapp" target="_blank" rel="noreferrer" className="px-4 py-2 rounded-xl border border-[#2a2a33] bg-[#111118] hover:bg-[#16161c] text-sm inline-flex items-center gap-2" title="Follow on X">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 3H22l-7.7 8.8L22.8 21H17l-5-6l-5.6 6H2.3l8.4-9.2L2 3h5.1l4.5 5.4L18.9 3z" /></svg>
            
          </a>
          <button onClick={() => setShowHow(true)} className="wiggle-2s px-4 py-2 rounded-xl border border-[#2a2a33] bg-[#111118] hover:bg-[#16161c] text-sm" title="How it works">
            How it works
          </button>

          {/* Wallets: overlays under the right buttons without shifting layout */}
          <div className="absolute right-0 top-full mt-2 w-56 z-50">
            <WalletStrip />
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="relative z-10 max-w-6xl mx-auto px-5">
        {/* ===== Toast Overlay (doesn't shift layout) ===== */}
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 z-[9997] mt-2"
             style={{ top: "72px" /* ~just under header/CA area */ }}>
          <AnimatePresence>
            {toast && (
              <div className="pointer-events-auto">
                <Toast msg={toast.msg} type={toast.type} />
              </div>
            )}
          </AnimatePresence>
        </div>

        {/* HERO: Timer progress bar + time */}
        <section className="py-4 sm:py-8 flex flex-col items-center text-center gap-4">
          {/* Fancy animated timer */}
          <div className="relative w-full max-w-xl">
            {/* Progress rail */}
            <div className="relative h-4 sm:h-5 rounded-full bg-neutral-800 overflow-hidden border border-white/10">
              {/* Fill with animated gradient */}
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${progressPct}%`,
                  background: `linear-gradient(90deg, #00FFC2, #00FFC2)`,
                  boxShadow: `0 0 16px #00FFC2`,
                }}
              >
                {/* Shimmer effect */}
                <div className="absolute inset-0 animate-[shimmer_2s_linear_infinite]" />
              </div>
            </div>

            {/* Time label */}
            <div className="mt-3 flex justify-center font-mono text-3xl sm:text-4xl font-bold tracking-wider text-[#00FFC2] drop-shadow-[0_0_12px_#00FFC2]">
              {String(Math.max(0, Math.min(99, Math.floor(msLeft / 60000)))).padStart(2, "0")}
              <span className="mx-1 animate-[blink_1s_infinite]">:</span>
              {String(Math.floor((msLeft % 60000) / 1000)).padStart(2, "0")}
            </div>

            {/* Keyframes */}
            <style jsx>{`
              @keyframes shimmer {
                0% { transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent); }
                100% { transform: translateX(100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent); }
              }
              @keyframes blink { 50% { opacity: 0.3; } }
            `}</style>
          </div>

          {/* Claim button + Share on X */}
          <div className="mt-2 flex flex-col items-center gap-3 w-full max-w-xl">
            <motion.button
              whileHover={{ scale: connected ? 1.02 : 1 }}
              whileTap={{ scale: connected ? 0.98 : 1 }}
              onClick={openClaimPreview}
              disabled={!connected || claiming}
              className={`btn-claim w-full ${(!connected || claiming) ? "disabled" : ""} ${connected ? "pulse" : ""}`}
            >
              {connected ? (claiming ? "Claiming…" : "CLAIM $PUMP") : "Connect Wallet to Claim"}
            </motion.button>

            <button
              onClick={() => shareOnX(null)}
              className="px-4 py-2 rounded-xl border border-[#2a2a33] bg-[#111118] hover:bg-[#16161c] text-sm inline-flex items-center gap-2"
              title="Share on X"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 3H22l-7.7 8.8L22.8 21H17l-5-6l-5.6 6H2.3l8.4-9.2L2 3h5.1l4.5 5.4L18.9 3z" /></svg>
              Share on X
            </button>

            {/* Entitlement summary */}
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
                  <div className="text-lg font-semibold">
                    {formatUSD(entitled * pumpPrice)}
                  </div>
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

        {/* Stats */}
        <section className="pb-8">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="card">
                <div className="badge">Total $PUMP Distributed</div>
                <div className="text-2xl font-semibold mt-1">
                  {totalDistributedPump.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                </div>
              </div>

              <div className="card">
                <div className="badge">$PUMP</div>
                <div className="text-2xl font-semibold mt-1 flex items-center gap-2">
                  <span>{pumpPrice ? `$${pumpPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : "—"}</span>
                  <span className={`flex items-center gap-1 text-sm ${isUp ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                    {isUp ? (
                      <svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4l7 8h-4v8H9v-8H5z" /></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M12 20l-7-8h4V4h6v8h4z" /></svg>
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
          </motion.div>
        </section>

        {/* Tabs */}
        <div className="flex items-center gap-2 mb-6">
          <button onClick={() => setTab("holders")} className={`px-3 py-1.5 rounded-lg text-xs ${tab === "holders" ? "bg-[#222]" : "bg-[#17171d] border border-[#24242f]"}`}>Holders</button>
          <button onClick={() => setTab("proofs")} className={`px-3 py-1.5 rounded-lg text-xs ${tab === "proofs" ? "bg-[#222]" : "bg-[#17171d] border border-[#24242f]"}`}>POW</button>
          <button onClick={() => setTab("feed")} className={`px-3 py-1.5 rounded-lg text-xs ${tab === "feed" ? "bg-[#222]" : "bg-[#17171d] border border-[#24242f]"}`}>Feed</button>
          <button onClick={() => setTab("history")} className={`px-3 py-1.5 rounded-lg text-xs ${tab === "history" ? "bg-[#222]" : "bg-[#17171d] border border-[#24242f]"}`}>My History</button>
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
  const addrDisplay = h.display ?? h.wallet; // <- prefer display if server provides it
  const globalIdx = (page - 1) * pageSize + i;
  const rank = rankMap.get(h.wallet.toLowerCase()) ?? (globalIdx + 1);
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
        <SolscanBtn value={addrDisplay} />                      {/* <- link using original case */}
      </td>
    </tr>
  );
})}
{pageItems.length === 0 && (
  <tr>
    <td className="px-3 py-3 opacity-60" colSpan={4}>No holders yet for this view.</td>
  </tr>
)}
</tbody>

              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-4">
              <div className="text-xs opacity-70">Page {page} / {totalPages}</div>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1.5 rounded-md bg-[#101017] border border-[#24242f] disabled:opacity-50">Prev</button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-3 py-1.5 rounded-md bg-[#101017] border border-[#24242f] disabled:opacity-50">Next</button>
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
                  <div className="font-semibold">{(proofs?.creatorSol || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL</div>
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
                ) : <span className="text-xs opacity-50">—</span>}
              </div>

              <div className="rounded-lg p-3 bg-[#101017] border border-[#24242f] flex items-center justify-between">
                <div>
                  <div className="opacity-60 text-xs">$PUMP swapped (this cycle)</div>
                  <div className="font-semibold">{(proofs?.pumpSwapped || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP</div>
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
                ) : <span className="text-xs opacity-50">—</span>}
              </div>
            </div>

            {/* Previous snapshots (foldable) */}
            <div className="mt-5">
              <button
                onClick={() => setShowPrev(v => !v)}
                className="px-3 py-2 rounded-lg text-xs bg-[#17171d] border border-[#24242f]"
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
                          <div>{(p.pumpBalance ?? p.deltaPump ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}</div>
                        </div>

                        <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                          <div>
                            <div className="opacity-60 text-xs">Creator rewards (SOL)</div>
                            <div className="font-semibold">{(p.creatorSol || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL</div>
                          </div>
                          {p?.txs?.claimSig ? (
                            <a className="text-xs underline opacity-80" target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${p.txs.claimSig}`}>
                              Solscan
                            </a>
                          ) : <span className="text-xs opacity-50">—</span>}
                        </div>

                        <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                          <div>
                            <div className="opacity-60 text-xs">$PUMP swapped</div>
                            <div className="font-semibold">{(p.pumpSwapped || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP</div>
                          </div>
                          {p?.txs?.swapSig ? (
                            <a className="text-xs underline opacity-80" target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${p.txs.swapSig}`}>
                              Solscan
                            </a>
                          ) : <span className="text-xs opacity-50">—</span>}
                        </div>

                        {/* CSV download if present */}
                        {p.csv ? (
                          <div className="rounded-lg p-3 bg-[#0f0f14] border border-[#24242f] flex items-center justify-between">
                            <div className="opacity-60 text-xs">Snapshot holders CSV</div>
                            <a className="text-xs underline opacity-80" href={p.csv}>Download</a>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ))}
                </div>
              )}
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

                    <div className="tabular-nums">{c.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP</div>
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

              {recent.length === 0 && (
                <div className="opacity-60 text-sm">No claims yet.</div>
              )}
            </div>
          </section>
        )}

        {/* My History (connected wallet only; derived from recent) */}
        {tab === "history" && (
          <section className="card mb-12">
            <h3 className="font-semibold mb-3">Your Claim History</h3>
            {!connected ? (
              <div className="opacity-60 text-sm">Connect a wallet to view your history.</div>
            ) : (
              <div className="space-y-2">
                {myHistory.map((c, i) => (
                  <div key={c.sig || i} className="flex items-center justify-between rounded-lg px-3 py-2 bg-[#101017] border border-[#24242f] text-sm">
                    <div className="tabular-nums">{c.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP</div>
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
                  <div className="opacity-60 text-sm">No claims found for this wallet (last 50 global claims scanned).</div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Signature Preview Modal */}
        {showPreview && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9998]">
            <div className="rounded-2xl p-5 w-[min(560px,92vw)]" style={{ background: "var(--panel)", border: "1px solid #333" }}>
              <h3 className="font-semibold mb-3">Review &amp; Sign</h3>
              <div className="text-sm space-y-2">
                <div className="rounded-lg p-3 bg-[#101017] border border-[#24242f]">
                  <div className="opacity-60 text-xs">Claiming</div>
                  <div>{(preview?.amount ?? unclaimed).toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP</div>
                </div>
                <div className="opacity-60 text-xs">Transaction includes standard Solana network fees (paid by you).</div>
              </div>
              <div className="mt-4 flex justify-end gap-3">
                <button onClick={() => setShowPreview(false)} className="px-4 py-2 rounded-xl" style={{ background: "#2a2a33" }}>Cancel</button>
                <button onClick={confirmAndClaim} disabled={claiming} className="px-4 py-2 rounded-xl" style={{ background: "var(--accent)", color: "#061915" }}>
                  {claiming ? "Submitting…" : "Sign & Send"}
                </button>
              </div>
            </div>
          </div>
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
              <div className="text-2xl font-semibold mt-1">{lastClaimAmt.toLocaleString(undefined, { maximumFractionDigits: 6 })} $PUMP</div>
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

        {/* How it works modal */}
        {showHow && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]">
            <div className="rounded-2xl p-5 w-[min(720px,92vw)] max-h-[82vh] overflow-auto" style={{ background: "var(--panel)", border: "1px solid #333" }}>
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-lg">How it works</div>
                <button onClick={() => setShowHow(false)} className="px-3 py-1 rounded-md" style={{ background: "#2a2a33" }}>Close</button>
              </div>
              <div className="space-y-3 text-sm leading-6 opacity-95 text-left">
<p className="leading-6">
  <b>PUMPDROP</b> is <span className="text-[var(--accent)] font-semibold animate-pulse">fully automated</span> — every 10 minutes it automatically collects creator rewards, swaps to <b>$PUMP</b>, and fairly splits them to all eligible holders (&gt; 10,000 $PUMPDROP). No staking, no forms, no manual distribution — just connect and claim.
</p>
                <ol className="list-decimal pl-5 space-y-2">
  <li>
    <b>Cycle basics.</b> A new drop happens every {CYCLE_MINUTES} minutes. The countdown bar shows the next distribution window.
  </li>

  <li>
    <b>Eligibility snapshot.</b> Moments before the timer ends (about {SNAPSHOT_OFFSET_SECONDS}s), we snapshot holders of <b>&gt; 10,000 $PUMPDROP</b>. AMM/LP and any blacklisted addresses are excluded to keep it fair.
    <ul className="mt-1 list-disc pl-5 space-y-1 opacity-80">
      <li>Your wallet balance at snapshot time determines eligibility for that cycle.</li>
      <li>No staking or LP position required—just hold the tokens in your wallet.</li>
    </ul>
  </li>

  <li>
    <b>Allocation math.</b> The $PUMP collected for the cycle is split evenly across all eligible wallets. Your “Claimable now” card shows the exact amount available to you.
  </li>

  <li>
    <b>Claiming.</b> Connect your wallet and press <b>CLAIM $PUMP</b>. You’ll review a single transaction, sign, and receive tokens instantly.
    <ul className="mt-1 list-disc pl-5 space-y-1 opacity-80">
      <li>If your $PUMP token account (ATA) doesn’t exist, the transaction creates it automatically.</li>
      <li>Standard Solana fees apply, plus a small app fee shown in the preview.</li>
    </ul>
  </li>

  <li>
    <b>Unclaimed rollovers.</b> If you miss a cycle, your allocation stays available. Each new cycle only uses fresh $PUMP—previous entitlements remain claimable.
  </li>

  <li>
    <b>Proof &amp; transparency.</b> The <b>POW</b> tab publishes the snapshot ID, hash, and on-chain transactions (with Solscan links) for creator rewards, swaps, and distributions.
  </li>

  <li>
    <b>Your history.</b> Connect your wallet to see a private <b>My History</b> list of your claims (amount, time, and Solscan link).
  </li>

  <li className="leading-6">
  <b className="text-red-500 animate-pulse">Safety.</b>{" "}
  We never ask for approvals or spending permissions—just a one-time claim transaction signed by you.{" "}
  <span className="text-red-500 font-semibold">Always verify details in your wallet before signing.</span>
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

/* Solscan button used in holders table — turns red briefly on click */
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
        ${isActive
          ? "bg-red-600 text-white border-transparent shadow scale-[0.98]"
          : "bg-[#101017] border-[#24242f] hover:bg-[#15151d] active:scale-95"}`}
      style={{ width: 82 }}
      title="Open on Solscan"
    >
      {isActive ? "Opened!" : "Solscan"}
    </a>
  );
}

/* === Wallet strip (copy with green success) — robust copy === */
function WalletCopyRow({ label, addr }: { label: string; addr: string }) {
  const [copied, setCopied] = useState(false);

  async function writeClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for odd/blocked environments
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
        className={`text-[11px] px-2 py-1 rounded-md border transition-all active:scale-95
          ${copied ? "border-transparent shadow" : "bg-[#0c0c12] border-[#2a2a33] hover:bg-[#14141b]"}`}
        // force accent green when copied
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
      <WalletCopyRow label="DEV"      addr="2FgpebF7Ms8gHPx4RrqgXxDkLMGn7jPn8uv4Q7AbgaMB" />
      <WalletCopyRow label="TREASURY" addr="Hqk72pLgP6h2b2dkLi4YuPXnWddc6hux9p3M82YpfbJG" />
      <WalletCopyRow label="TEAM"     addr="6vYrrqc4Rsj7QhaTY1HN3YRpRmwP5TEq9zss5HKyd5fh" />
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




