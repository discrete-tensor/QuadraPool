// Experiments for the report. Runs on the in-process Hardhat network.
//   npx hardhat run scripts/experiment.js
// Output: results/experiment.json
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const E = (x) => ethers.parseEther(String(x));
const toEth = (x) => Number(ethers.formatEther(x));
const DAY = 86400;

async function freshPool(allowlist = false, nProjects = 2, matching = "1") {
  const [owner] = await ethers.getSigners();
  const F = await ethers.getContractFactory("QuadraticFundingPool");
  const pool = await F.deploy("Experiment", 7 * DAY, E("0.0001"), allowlist);
  for (let i = 0; i < nProjects; i++) await pool.addProject("P" + i, "", owner.address);
  await pool.fundMatchingPool({ value: E(matching) });
  return pool;
}

async function gasOf(txPromise) {
  const tx = await txPromise;
  const r = await tx.wait();
  return Number(r.gasUsed);
}

async function main() {
  const signers = await ethers.getSigners(); // 40 accounts configured in hardhat.config
  const out = {};

  // --- Exp 1: same total (0.12 ETH) split across N donors vs. a 1-donor-per-... baseline.
  // Project 0: total 0.12 ETH split evenly across N donors.
  // Project 1: fixed reference -> 3 donors x 0.04 ETH (same total).
  const exp1 = [];
  for (const N of [1, 2, 3, 4, 6, 8, 12, 16, 24]) {
    const pool = await freshPool(false, 2, "1");
    const each = E("0.12") / BigInt(N);
    for (let i = 0; i < N; i++) await pool.connect(signers[1 + i]).contribute(0, { value: each });
    for (let i = 0; i < 3; i++) await pool.connect(signers[30 + i]).contribute(1, { value: E("0.04") });
    exp1.push({
      donors: N,
      match0: toEth(await pool.estimatedMatch(0)),
      match1: toEth(await pool.estimatedMatch(1)),
    });
  }
  out.exp1_split = exp1;

  // --- Exp 2: Sybil attack. Attacker has 0.01 ETH, splits into k addresses on project 0.
  // Honest project 1 has 4 real donors x 0.01 ETH. Allow-list off vs on.
  const exp2 = [];
  for (const k of [1, 2, 4, 8, 12, 16]) {
    for (const allow of [false, true]) {
      const pool = await freshPool(allow, 2, "1");
      if (allow) {
        // Only one identity per human: attacker's first address + honest donors.
        await pool.setAllowlist([signers[1].address, ...signers.slice(30, 34).map((s) => s.address)], true);
      }
      const each = E("0.01") / BigInt(k);
      let accepted = 0;
      for (let i = 0; i < k; i++) {
        try {
          await pool.connect(signers[1 + i]).contribute(0, { value: each });
          accepted++;
        } catch (_) { /* NotAllowlisted */ }
      }
      for (let i = 0; i < 4; i++) await pool.connect(signers[30 + i]).contribute(1, { value: E("0.01") });
      exp2.push({
        sybils: k,
        allowlist: allow,
        accepted,
        attackerMatch: toEth(await pool.estimatedMatch(0)),
        honestMatch: toEth(await pool.estimatedMatch(1)),
      });
    }
  }
  out.exp2_sybil = exp2;

  // --- Exp 3: gas per operation.
  {
    const [owner] = signers;
    const F = await ethers.getContractFactory("QuadraticFundingPool");
    const pool = await F.deploy("Gas", 7 * DAY, E("0.0001"), false);
    const deployGas = Number((await pool.deploymentTransaction().wait()).gasUsed);
    const addGas = await gasOf(pool.addProject("Project A", "Short description", owner.address));
    await pool.addProject("Project B", "", owner.address);
    const fundGas = await gasOf(pool.fundMatchingPool({ value: E(1) }));
    const firstContrib = await gasOf(pool.connect(signers[1]).contribute(0, { value: E("0.01") }));
    const repeatContrib = await gasOf(pool.connect(signers[1]).contribute(0, { value: E("0.01") }));
    await pool.connect(signers[2]).contribute(0, { value: E("0.01") });
    await network.provider.send("evm_increaseTime", [7 * DAY]);
    await network.provider.send("evm_mine");
    const finGas = await gasOf(pool.finalize());
    const claimGas = await gasOf(pool.claim(0));
    out.exp3_gas = {
      deploy: deployGas, addProject: addGas, fundMatchingPool: fundGas,
      contributeFirst: firstContrib, contributeRepeat: repeatContrib,
      finalize2Projects: finGas, claim: claimGas,
    };
  }

  // --- Exp 4: finalize() gas vs number of projects (bounded loop justification).
  const exp4 = [];
  for (const n of [1, 2, 5, 10, 15, 20]) {
    const pool = await freshPool(false, n, "1");
    for (let i = 0; i < n; i++) {
      await pool.connect(signers[1]).contribute(i, { value: E("0.001") });
      await pool.connect(signers[2]).contribute(i, { value: E("0.002") });
    }
    await network.provider.send("evm_increaseTime", [7 * DAY]);
    await network.provider.send("evm_mine");
    exp4.push({ projects: n, finalizeGas: await gasOf(pool.finalize()) });
  }
  out.exp4_finalize = exp4;

  const dir = path.join(__dirname, "..", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "experiment.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
