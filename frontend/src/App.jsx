import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, Interface, formatEther, parseEther, isAddress } from "ethers";
import {
  CONTRACT_ADDRESS, POOL_ABI, SEPOLIA_CHAIN_ID, SEPOLIA_EXPLORER_URL, STATUS,
} from "./contract";

// ---------- helpers (pattern from Project Lab) ----------
const shortAddress = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "");
const fmt = (wei, d = 4) => Number(formatEther(wei ?? 0n)).toFixed(d);

function getProvider() {
  if (!window.ethereum) throw new Error("MetaMask not detected. Please install it.");
  return new BrowserProvider(window.ethereum);
}

async function ensureSepolia() {
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId !== SEPOLIA_CHAIN_ID) {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_CHAIN_ID }],
    });
  }
}

// v4.2: decode custom errors that ethers could not map (shows "unknown custom error").
const POOL_IFACE = new Interface(POOL_ABI);
function findRevertName(e, depth = 0) {
  if (!e || depth > 6) return null;
  if (e.revert?.name) return e.revert.name;
  const candidates = [e.data, e.error?.data, e.info?.error?.data, e.data?.data, e.error?.data?.data];
  for (const d of candidates) {
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8}/.test(d)) {
      try { const p = POOL_IFACE.parseError(d); if (p?.name) return p.name; } catch { /* ignore */ }
    }
  }
  for (const k of ["error", "info", "cause"]) {
    if (e[k] && typeof e[k] === "object") {
      const n = findRevertName(e[k], depth + 1);
      if (n) return n;
    }
  }
  return null;
}

function friendlyError(e) {
  const m = e?.shortMessage || e?.reason || e?.message || String(e);
  const map = {
    NotAllowlisted: "Your address is not on the allow-list (Sybil protection).",
    BelowMinimum: "Amount is below the minimum contribution.",
    RoundEnded: "The contribution window has closed.",
    RoundNotOpen: "The round is not open.",
    RoundStillRunning: "The round has not ended yet.",
    NotRecipient: "Only the project recipient can claim.",
    AlreadyClaimed: "Funds already claimed.",
    NothingToRefund: "Nothing to refund.",
  };
  const name = findRevertName(e) || Object.keys(map).find((k) => m.includes(k));
  return map[name] || m;
}

// Off-chain QF math (mirrors the contract) for the live chart.
function weight(sumSqrt, total) {
  const sq = sumSqrt * sumSqrt;
  return sq > total ? sq - total : 0n;
}

export default function App() {
  const [account, setAccount] = useState("");
  const [owner, setOwner] = useState("");
  const [info, setInfo] = useState(null);
  const [projects, setProjects] = useState([]);
  const [myContrib, setMyContrib] = useState({});
  const [msg, setMsg] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState("");

  const configured = isAddress(CONTRACT_ADDRESS) && CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000";
  const isOwner = account && owner && account.toLowerCase() === owner.toLowerCase();

  const readContract = useCallback(async () => {
    const provider = getProvider();
    return new Contract(CONTRACT_ADDRESS, POOL_ABI, provider);
  }, []);

  const writeContract = useCallback(async () => {
    await ensureSepolia();
    const signer = await getProvider().getSigner();
    return new Contract(CONTRACT_ADDRESS, POOL_ABI, signer);
  }, []);

  // ---------- load on-chain state ----------
  const refresh = useCallback(async () => {
    if (!configured || !window.ethereum) return;
    try {
      const c = await readContract();
      const [name, endTime, minC, status, allow, pool, own, list, dust] = await Promise.all([
        c.roundName(), c.endTime(), c.minContribution(), c.status(), c.allowlistEnabled(),
        c.matchingPool(), c.owner(), c.getAllProjects(), c.dust(),
      ]);
      const est = await Promise.all(list.map((_, i) => c.estimatedMatch(i)));
      setOwner(own);
      setInfo({
        name, endTime: Number(endTime), minC, status: Number(status), allow, pool, dust,
      });
      setProjects(list.map((p, i) => ({
        id: i, name: p.name, description: p.description, recipient: p.recipient,
        total: p.totalContributed, sumSqrt: p.sumSqrt, count: Number(p.contributorCount),
        matchAmount: p.matchAmount, claimed: p.claimed, est: est[i],
      })));
      if (account) {
        const mine = await Promise.all(list.map((_, i) => c.contributionOf(i, account)));
        setMyContrib(Object.fromEntries(mine.map((v, i) => [i, v])));
      }
    } catch (e) {
      setMsg({ type: "err", text: friendlyError(e) });
    }
  }, [configured, readContract, account]);

  // ---------- wallet ----------
  async function connectWallet() {
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      await ensureSepolia();
      setAccount(accounts[0] || "");
      setMsg({ type: "ok", text: "Wallet connected." });
    } catch (e) {
      setMsg({ type: "err", text: friendlyError(e) });
    }
  }

  useEffect(() => {
    if (!window.ethereum) return;
    window.ethereum.request({ method: "eth_accounts" }).then((a) => setAccount(a[0] || ""));
    const onAcc = (a) => setAccount(a[0] || "");
    const onChain = () => window.location.reload();
    window.ethereum.on("accountsChanged", onAcc);
    window.ethereum.on("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAcc);
      window.ethereum.removeListener("chainChanged", onChain);
    };
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  // ---------- generic tx runner ----------
  async function run(label, fn) {
    setBusy(true);
    // v3: remember which account started this tx, so switching accounts mid-way stays visible
    const who = account ? ` from ${shortAddress(account)}` : "";
    setMsg({ type: "info", text: `${label}${who}: confirm in MetaMask...` });
    try {
      const c = await writeContract();
      // v4.3: dry-run the same call first (eth_call from this account). Reverts from
      // staticCall go through the contract ABI, so the real custom error name is decoded.
      const dry = new Proxy(c, {
        get: (t, k) => (typeof t[k]?.staticCall === "function" ? (...a) => t[k].staticCall(...a) : t[k]),
      });
      await fn(dry);
      const tx = await fn(c);
      setLastTx(tx.hash);
      setMsg({ type: "info", text: `${label}${who}: pending ${shortAddress(tx.hash)}...` });
      await tx.wait();
      setMsg({ type: "ok", text: `${label}${who}: confirmed.` });
      await refresh();
    } catch (e) {
      setMsg({ type: "err", text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const open = info && info.status === 0 && now < info.endTime;
  const ended = info && info.status === 0 && now >= info.endTime;
  const totalEst = useMemo(() => projects.reduce((a, p) => a + p.est, 0n), [projects]);

  return (
    <div className="wrap">
      <header>
        <div>
          <h1>QuadraPool</h1>
          <p className="sub">Quadratic Funding for public goods - many small donors &gt; one whale</p>
        </div>
        {account ? (
          <span className="pill">{shortAddress(account)}{isOwner ? " (operator)" : ""}</span>
        ) : (
          <button onClick={connectWallet}>Connect MetaMask</button>
        )}
      </header>

      {!configured && (
        <div className="msg err">Set VITE_CONTRACT_ADDRESS in frontend/.env after deploying (see README).</div>
      )}
      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}
      {lastTx && (
        <p className="small">
          Last tx: <a href={`${SEPOLIA_EXPLORER_URL}/tx/${lastTx}`} target="_blank" rel="noreferrer">{shortAddress(lastTx)}</a>
        </p>
      )}

      {info && <Steps stage={info.status === 2 ? -1 : info.status === 1 ? 3 : ended ? 2 : 1} />}

      {info && (
        <section className="card stats">
          <Stat label="Round" value={info.name} />
          <Stat label="Status" value={ended ? "Ended (awaiting finalize)" : STATUS[info.status]} />
          <Stat className="pool" label="Matching pool" value={`${fmt(info.pool)} ETH`} />
          <Stat label="Ends" value={
            <>
              {new Date(info.endTime * 1000).toLocaleString()}{" "}
              <Countdown endTime={info.endTime} />
            </>
          } />
          <Stat label="Sybil allow-list" value={info.allow ? "ON" : "OFF"} />
          <Stat label="Contract" value={
            <a href={`${SEPOLIA_EXPLORER_URL}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer">{shortAddress(CONTRACT_ADDRESS)}</a>
          } />
        </section>
      )}

      {/* v4.1: sponsor box only while the round is open */}
      {info && open && (
        <SponsorBox disabled={!account || busy || !open}
          onFund={(v) => run("Fund matching pool", (c) => c.fundMatchingPool({ value: parseEther(v) }))} />
      )}

      <h2>Projects</h2>
      <div className="grid">
        {projects.map((p) => (
          <ProjectCard key={p.id} p={p} info={info} account={account} busy={busy} open={open}
            mine={myContrib[p.id] || 0n} totalEst={totalEst} readContract={readContract}
            onContribute={(v) => run(`Contribute to ${p.name}`, (c) => c.contribute(p.id, { value: parseEther(v) }))}
            onClaim={() => run(`Claim ${p.name}`, (c) => c.claim(p.id))}
            onRefund={() => run(`Refund ${p.name}`, (c) => c.refund(p.id))} />
        ))}
        {configured && projects.length === 0 && <p className="small">No projects yet.</p>}
      </div>

      {info && info.status === 0 && ended && (
        <section className="card cta">
          <h3>Round ended</h3>
          <p className="small">Anyone can trigger settlement. This freezes matching amounts.</p>
          <button disabled={!account || busy} onClick={() => run("Finalize", (c) => c.finalize())}>Finalize round</button>
        </section>
      )}

      {info && info.status === 2 && (
        <section className="card">
          <h3>Round cancelled</h3>
          <p className="small">Contributors use "Refund" on each project; sponsors withdraw below.</p>
          <button disabled={!account || busy} onClick={() => run("Sponsor refund", (c) => c.refundSponsor())}>Withdraw my sponsorship</button>
        </section>
      )}

      {isOwner && info && (
        <AdminPanel info={info} busy={busy} open={open} run={run} />
      )}

      <footer className="small">
        Matching formula: match<sub>p</sub> = pool x [(Σ√c<sub>i</sub>)² − Σc<sub>i</sub>] / Σ<sub>q</sub>[...]. COMP7610 Final Project - Sepolia testnet only.
      </footer>
    </div>
  );
}

// v4.1: visual guide of the round lifecycle (display only).
function Countdown({ endTime }) {
  const [rem, setRem] = useState(endTime - Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => {
      const r = endTime - Math.floor(Date.now() / 1000);
      setRem(r > 0 ? r : 0);
    }, 1000);
    return () => clearInterval(t);
  }, [endTime]);
  if (rem <= 0) return <b>(Ended)</b>;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return <b>({m}m {s.toString().padStart(2, '0')}s left)</b>;
}
const STEPS = [
  ["Fund", "Sponsor deposits the matching pool"],
  ["Contribute", "Donors give small amounts to projects"],
  ["Finalize", "After the deadline, anyone settles the round"],
  ["Claim", "Each recipient pulls donations + matching"],
];

function Steps({ stage }) {
  return (
    <ol className="steps" aria-label="Round lifecycle">
      {STEPS.map(([t, d], i) => (
        <li key={t} className={i === stage ? "active" : ""} aria-current={i === stage ? "step" : undefined}>
          <span className="n">{i + 1}</span><b>{t}</b>
          <span className="d">{d}</span>
        </li>
      ))}
    </ol>
  );
}

function Stat({ label, value, className = "" }) {
  return (
    <div className={className}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function SponsorBox({ disabled, onFund }) {
  const [v, setV] = useState("0.01");
  return (
    <section className="card row">
      <strong>Sponsor the matching pool</strong>
      <input aria-label="Sponsor amount in ETH" value={v} onChange={(e) => setV(e.target.value)} />
      <span>ETH</span>
      <button disabled={disabled} onClick={() => onFund(v)}>Fund</button>
    </section>
  );
}

function ProjectCard({ p, info, account, busy, open, mine, totalEst, readContract, onContribute, onClaim, onRefund }) {
  const [amt, setAmt] = useState("0.002");
  const [preview, setPreview] = useState(null);

  // Live "what-if" preview from the contract's view function.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        if (!open || !account || !amt || Number(amt) <= 0) return setPreview(null);
        const c = await readContract();
        const [b, a] = await c.previewContribution(p.id, account, parseEther(amt));
        if (alive) setPreview({ before: b, after: a });
      } catch {
        if (alive) setPreview(null);
      }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [amt, account, open, p.id, p.total, readContract]);

  const share = totalEst > 0n ? Number((p.est * 10000n) / totalEst) / 100 : 0;
  const finalized = info?.status === 1;
  const cancelled = info?.status === 2;
  const isRecipient = account && account.toLowerCase() === p.recipient.toLowerCase();
  const w = weight(p.sumSqrt, p.total);

  return (
    <article className="card project">
      <h3>{p.name}</h3>
      <p className="small">{p.description}</p>
      <div className="match">
        <div className="label">{finalized ? "Matching (final)" : "Matching (estimated)"}</div>
        <div className="big">{fmt(finalized ? p.matchAmount : p.est)} ETH</div>
        <div className="bar" aria-label={`Matching share ${share}%`}><span style={{ width: `${share}%` }} /></div>
        <div className="small"><span className="share">{share}%</span> of matching pool</div>
      </div>
      <dl>
        <dt>Contributors</dt><dd>{p.count}</dd>
        <dt>Raised directly</dt><dd>{fmt(p.total)} ETH</dd>
        <dt>QF weight</dt><dd>{Number(formatEther(w)).toExponential(2)}</dd>
        <dt>Recipient</dt><dd>{shortAddress(p.recipient)}</dd>
        {mine > 0n && (<><dt>Your contribution</dt><dd>{fmt(mine)} ETH</dd></>)}
      </dl>

      {open && (
        <>
          <div className="row">
            <input aria-label={`Contribution to ${p.name} in ETH`} value={amt} onChange={(e) => setAmt(e.target.value)} />
            <span>ETH</span>
            <button disabled={!account || busy} onClick={() => onContribute(amt)}>Contribute</button>
          </div>
          {preview && (
            <p className="small preview">
              Your {amt} ETH would move matching from {fmt(preview.before)} to <b>{fmt(preview.after)}</b> ETH
              {" "}(+{fmt(preview.after - preview.before > 0n ? preview.after - preview.before : 0n)}).
            </p>
          )}
        </>
      )}
      {finalized && isRecipient && !p.claimed && (
        <button className="claim" disabled={busy} onClick={onClaim}>Claim {fmt(p.total + p.matchAmount)} ETH</button>
      )}
      {finalized && p.claimed && <p className="small ok-text">Claimed by recipient.</p>}
      {cancelled && mine > 0n && <button disabled={busy} onClick={onRefund}>Refund {fmt(mine)} ETH</button>}
    </article>
  );
}

function AdminPanel({ info, busy, open, run }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [rec, setRec] = useState("");
  const [list, setList] = useState("");

  const addrs = list.split(/[\s,;]+/).filter(Boolean);
  const bad = addrs.filter((a) => !isAddress(a));

  return (
    <section className="card admin">
      <h2>Operator panel</h2>
      <div className="row wrapRow">
        <input aria-label="Project name" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Project description" placeholder="Short description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <input aria-label="Recipient address" placeholder="Recipient 0x..." value={rec} onChange={(e) => setRec(e.target.value)} />
        <button disabled={busy || !open || !name || !isAddress(rec)}
          onClick={() => run("Add project", (c) => c.addProject(name, desc, rec))}>Add project</button>
      </div>

      <label className="small" htmlFor="allow">Allow-list addresses (comma / space separated)</label>
      <textarea id="allow" rows={3} value={list} onChange={(e) => setList(e.target.value)} />
      {bad.length > 0 && <p className="small err-text">Invalid: {bad.join(", ")}</p>}
      <div className="row wrapRow">
        <button disabled={busy || !addrs.length || bad.length > 0}
          onClick={() => run("Allow-list add", (c) => c.setAllowlist(addrs, true))}>Add to allow-list</button>
        <button disabled={busy || !addrs.length || bad.length > 0}
          onClick={() => run("Allow-list remove", (c) => c.setAllowlist(addrs, false))}>Remove</button>
        <button disabled={busy || !open}
          onClick={() => run("Toggle allow-list", (c) => c.setAllowlistEnabled(!info.allow))}>
          Turn allow-list {info.allow ? "OFF" : "ON"}
        </button>
      </div>
      <div className="row wrapRow">
        {info.status === 0 && (
          <button className="danger" disabled={busy}
            onClick={() => window.confirm("Cancel the round? Everyone will be able to withdraw.") && run("Cancel round", (c) => c.cancelRound())}>
            Cancel round
          </button>
        )}
        {info.status === 1 && info.dust > 0n && (
          <button disabled={busy} onClick={() => run("Withdraw dust", (c) => c.withdrawDust())}>
            Withdraw rounding dust ({info.dust.toString()} wei)
          </button>
        )}
      </div>
    </section>
  );
}
