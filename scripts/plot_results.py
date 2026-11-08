"""Plot experiment results for the report.
Usage: python scripts/plot_results.py   (after `npm run experiment`)
"""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "results")
data = json.load(open(os.path.join(RES, "experiment.json"), encoding="utf-8"))
plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False})

# Fig 1: matching vs number of donors (same total)
e1 = data["exp1_split"]
x = [r["donors"] for r in e1]
fig, ax = plt.subplots(figsize=(7, 4))
ax.plot(x, [r["match0"] for r in e1], "o-", color="#2563eb", label="Project A: 0.12 ETH split over N donors")
ax.plot(x, [r["match1"] for r in e1], "s--", color="#9ca3af", label="Project B: 3 donors x 0.04 ETH (fixed)")
ax.set_xlabel("Number of donors to Project A (same 0.12 ETH total)")
ax.set_ylabel("Matching received (ETH, pool = 1 ETH)")
ax.set_title("Fig. 1  Breadth of support beats size of support")
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(os.path.join(RES, "fig1_donors.png"), dpi=160)

# Fig 2: Sybil attack with/without allow-list
e2 = data["exp2_sybil"]
ks = sorted({r["sybils"] for r in e2})
off = [next(r for r in e2 if r["sybils"] == k and not r["allowlist"])["attackerMatch"] for k in ks]
on = [next(r for r in e2 if r["sybils"] == k and r["allowlist"])["attackerMatch"] for k in ks]
fig, ax = plt.subplots(figsize=(7, 4))
w = 0.38
idx = range(len(ks))
ax.bar([i - w / 2 for i in idx], off, w, color="#dc2626", label="Allow-list OFF")
ax.bar([i + w / 2 for i in idx], on, w, color="#16a34a", label="Allow-list ON")
ax.set_xticks(list(idx), [str(k) for k in ks])
ax.set_xlabel("Sybil addresses used by attacker (same 0.01 ETH)")
ax.set_ylabel("Attacker's share of 1 ETH pool")
ax.set_title("Fig. 2  Sybil attack and allow-list mitigation")
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(os.path.join(RES, "fig2_sybil.png"), dpi=160)

# Fig 3: finalize gas vs projects
e4 = data["exp4_finalize"]
fig, ax = plt.subplots(figsize=(7, 4))
ax.plot([r["projects"] for r in e4], [r["finalizeGas"] / 1000 for r in e4], "o-", color="#7c3aed")
ax.set_xlabel("Number of projects")
ax.set_ylabel("finalize() gas (thousand)")
ax.set_title("Fig. 3  finalize() gas grows linearly (bounded by MAX_PROJECTS=20)")
fig.tight_layout()
fig.savefig(os.path.join(RES, "fig3_gas.png"), dpi=160)
print("saved figures to", RES)
