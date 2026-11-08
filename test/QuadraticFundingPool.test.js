const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (x) => ethers.parseEther(String(x));
const DAY = 24 * 60 * 60;

// Off-chain reference implementation of the CLR formula (BigInt, floor sqrt).
function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
function weight(contribs) {
  const s = contribs.reduce((a, c) => a + isqrt(c), 0n);
  const t = contribs.reduce((a, c) => a + c, 0n);
  return s * s > t ? s * s - t : 0n;
}

describe("QuadraticFundingPool", function () {
  async function deploy(allowlist = false) {
    const signers = await ethers.getSigners();
    const [owner, sponsor, alice, bob, carol, dave, eve, recA, recB, recC] = signers;
    const F = await ethers.getContractFactory("QuadraticFundingPool");
    const pool = await F.deploy("HKU Public Goods Round", 7 * DAY, E("0.001"), allowlist);
    await pool.addProject("Campus Water Fountains", "Refill stations", recA.address);
    await pool.addProject("Open Course Notes", "Free notes", recB.address);
    await pool.addProject("Stray Cat Shelter", "Food & vet", recC.address);
    await pool.connect(sponsor).fundMatchingPool({ value: E(10) });
    return { pool, owner, sponsor, alice, bob, carol, dave, eve, recA, recB, recC, signers };
  }
  const deployOpen = () => deploy(false);
  const deployAllow = () => deploy(true);

  describe("Registration & funding", function () {
    it("stores projects and matching pool", async function () {
      const { pool, recA } = await loadFixture(deployOpen);
      expect(await pool.projectCount()).to.equal(3n);
      expect((await pool.getProject(0)).recipient).to.equal(recA.address);
      expect(await pool.matchingPool()).to.equal(E(10));
    });

    it("only owner can add projects; zero address rejected", async function () {
      const { pool, alice } = await loadFixture(deployOpen);
      await expect(pool.connect(alice).addProject("x", "y", alice.address))
        .to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
      await expect(pool.addProject("x", "y", ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("enforces MAX_PROJECTS", async function () {
      const { pool, alice } = await loadFixture(deployOpen);
      for (let i = 3; i < 20; i++) await pool.addProject("p" + i, "", alice.address);
      await expect(pool.addProject("p20", "", alice.address))
        .to.be.revertedWithCustomError(pool, "TooManyProjects");
    });

    it("rejects contributions below minimum and to invalid project", async function () {
      const { pool, alice } = await loadFixture(deployOpen);
      await expect(pool.connect(alice).contribute(0, { value: E("0.0001") }))
        .to.be.revertedWithCustomError(pool, "BelowMinimum");
      await expect(pool.connect(alice).contribute(9, { value: E(1) }))
        .to.be.revertedWithCustomError(pool, "InvalidProject");
    });

    it("rejects contributions after endTime", async function () {
      const { pool, alice } = await loadFixture(deployOpen);
      await time.increase(7 * DAY);
      await expect(pool.connect(alice).contribute(0, { value: E(1) }))
        .to.be.revertedWithCustomError(pool, "RoundEnded");
    });
  });

  describe("Quadratic math", function () {
    it("tracks sumSqrt and merges repeat contributions per address", async function () {
      const { pool, alice } = await loadFixture(deployOpen);
      await pool.connect(alice).contribute(0, { value: E(1) });
      await pool.connect(alice).contribute(0, { value: E(3) });
      const p = await pool.getProject(0);
      expect(p.contributorCount).to.equal(1n);
      expect(p.totalContributed).to.equal(E(4));
      expect(p.sumSqrt).to.equal(isqrt(E(4))); // sqrt(4 ETH), not sqrt(1)+sqrt(3)
      expect(await pool.weightOf(0)).to.equal(0n); // single contributor => no matching
    });

    it("many small donors beat one whale with the same total (hand-checked)", async function () {
      // Project 0: 4 donors x 1 ETH -> (4*1)^2 - 4 = 12 ETH-units
      // Project 1: 1 donor  x 4 ETH -> 0
      // Project 2: 2 donors x 1 ETH -> (2)^2 - 2 = 2
      const { pool, alice, bob, carol, dave, eve } = await loadFixture(deployOpen);
      for (const s of [alice, bob, carol, dave]) await pool.connect(s).contribute(0, { value: E(1) });
      await pool.connect(eve).contribute(1, { value: E(4) });
      await pool.connect(alice).contribute(2, { value: E(1) });
      await pool.connect(bob).contribute(2, { value: E(1) });

      await time.increase(7 * DAY);
      await pool.finalize();

      // weights in wei^1 units: 12e18 and 2e18 -> shares 12/14, 2/14 of 10 ETH
      const m0 = (await pool.getProject(0)).matchAmount;
      const m1 = (await pool.getProject(1)).matchAmount;
      const m2 = (await pool.getProject(2)).matchAmount;
      expect(m1).to.equal(0n);
      expect(m0).to.equal((E(10) * 12n) / 14n);
      expect(m2).to.equal((E(10) * 2n) / 14n);
      expect(m0 + m1 + m2 + (await pool.dust())).to.equal(E(10));
    });

    it("matches off-chain reference for an irregular distribution", async function () {
      const { pool, signers } = await loadFixture(deployOpen);
      const plan = {
        0: ["0.013", "0.27", "1.5", "0.002"],
        1: ["2.2", "0.04"],
        2: ["0.5", "0.5", "0.5", "0.123", "0.009"],
      };
      const contribs = { 0: [], 1: [], 2: [] };
      let k = 2;
      for (const pid of [0, 1, 2]) {
        for (const amt of plan[pid]) {
          await pool.connect(signers[k++ % 18 + 2]).contribute(pid, { value: E(amt) });
          contribs[pid].push(E(amt));
        }
      }
      const w = [0, 1, 2].map((i) => weight(contribs[i]));
      for (const i of [0, 1, 2]) expect(await pool.weightOf(i)).to.equal(w[i]);

      await time.increase(7 * DAY);
      await pool.finalize();
      const total = w[0] + w[1] + w[2];
      let sum = 0n;
      for (const i of [0, 1, 2]) {
        const m = (await pool.getProject(i)).matchAmount;
        expect(m).to.equal((E(10) * w[i]) / total);
        sum += m;
      }
      const dust = await pool.dust();
      expect(sum + dust).to.equal(E(10));
      expect(dust).to.be.lessThan(3n); // at most (n-1) wei of rounding
    });

    it("previewContribution equals the real outcome", async function () {
      const { pool, alice, bob, carol } = await loadFixture(deployOpen);
      await pool.connect(alice).contribute(0, { value: E(1) });
      await pool.connect(bob).contribute(1, { value: E(1) });
      await pool.connect(carol).contribute(1, { value: E(1) });
      const [before, after] = await pool.previewContribution(0, bob.address, E("0.5"));
      await pool.connect(bob).contribute(0, { value: E("0.5") });
      expect(await pool.estimatedMatch(0)).to.equal(after);
      expect(after).to.be.greaterThan(before);
    });

    it("degenerate round (all weights 0) falls back to pro-rata", async function () {
      const { pool, alice, bob } = await loadFixture(deployOpen);
      await pool.connect(alice).contribute(0, { value: E(3) });
      await pool.connect(bob).contribute(1, { value: E(1) });
      await time.increase(7 * DAY);
      await pool.finalize();
      expect((await pool.getProject(0)).matchAmount).to.equal(E("7.5"));
      expect((await pool.getProject(1)).matchAmount).to.equal(E("2.5"));
    });
  });

  describe("Sybil resistance (allow-list)", function () {
    it("Sybil attack succeeds without allow-list", async function () {
      // Attacker splits 0.01 ETH over 5 fresh addresses on project 0;
      // honest single donor gives 0.01 ETH to project 1 and one friend 0.002.
      const { pool, signers } = await loadFixture(deployOpen);
      const sybils = signers.slice(10, 15);
      for (const s of sybils) await pool.connect(s).contribute(0, { value: E("0.002") });
      await pool.connect(signers[15]).contribute(1, { value: E("0.01") });
      await pool.connect(signers[16]).contribute(1, { value: E("0.002") });
      expect(await pool.estimatedMatch(0)).to.be.greaterThan(await pool.estimatedMatch(1));
    });

    it("allow-list blocks Sybil addresses", async function () {
      const { pool, owner, alice, signers } = await loadFixture(deployAllow);
      await pool.connect(owner).setAllowlist([alice.address], true);
      await pool.connect(alice).contribute(0, { value: E("0.01") });
      await expect(pool.connect(signers[12]).contribute(0, { value: E("0.002") }))
        .to.be.revertedWithCustomError(pool, "NotAllowlisted");
    });
  });

  describe("Settlement & payouts", function () {
    it("cannot finalize early or twice", async function () {
      const { pool } = await loadFixture(deployOpen);
      await expect(pool.finalize()).to.be.revertedWithCustomError(pool, "RoundStillRunning");
      await time.increase(7 * DAY);
      await pool.finalize();
      await expect(pool.finalize()).to.be.revertedWithCustomError(pool, "RoundNotOpen");
    });

    it("recipient claims contributions + matching exactly once", async function () {
      const { pool, alice, bob, recA, recB } = await loadFixture(deployOpen);
      await pool.connect(alice).contribute(0, { value: E(1) });
      await pool.connect(bob).contribute(0, { value: E(1) });
      await time.increase(7 * DAY);
      await pool.finalize();
      const m = (await pool.getProject(0)).matchAmount;
      expect(m).to.equal(E(10)); // only project with weight
      await expect(pool.connect(recB).claim(0)).to.be.revertedWithCustomError(pool, "NotRecipient");
      await expect(pool.connect(recA).claim(0)).to.changeEtherBalance(recA, E(2) + m);
      await expect(pool.connect(recA).claim(0)).to.be.revertedWithCustomError(pool, "AlreadyClaimed");
    });

    it("cannot claim before finalize", async function () {
      const { pool, recA } = await loadFixture(deployOpen);
      await expect(pool.connect(recA).claim(0)).to.be.revertedWithCustomError(pool, "NotFinalized");
    });

    it("contract balance is fully drained after all claims + dust", async function () {
      const { pool, owner, signers, recA, recB, recC } = await loadFixture(deployOpen);
      const amts = ["0.37", "0.011", "1.3", "0.9", "0.05", "0.07"];
      for (let i = 0; i < amts.length; i++) await pool.connect(signers[10 + i]).contribute(i % 3, { value: E(amts[i]) });
      await time.increase(7 * DAY);
      await pool.finalize();
      for (const [i, r] of [[0, recA], [1, recB], [2, recC]]) await pool.connect(r).claim(i);
      if ((await pool.dust()) > 0n) await pool.connect(owner).withdrawDust();
      expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(0n);
    });
  });

  describe("Cancellation & refunds", function () {
    it("contributors and sponsors get refunds after cancel", async function () {
      const { pool, sponsor, alice } = await loadFixture(deployOpen);
      await pool.connect(alice).contribute(0, { value: E(1) });
      await pool.cancelRound();
      await expect(pool.connect(alice).refund(0)).to.changeEtherBalance(alice, E(1));
      await expect(pool.connect(alice).refund(0)).to.be.revertedWithCustomError(pool, "NothingToRefund");
      await expect(pool.connect(sponsor).refundSponsor()).to.changeEtherBalance(sponsor, E(10));
      expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(0n);
    });

    it("refund not possible while open", async function () {
      const { pool, alice } = await loadFixture(deployOpen);
      await pool.connect(alice).contribute(0, { value: E(1) });
      await expect(pool.connect(alice).refund(0)).to.be.revertedWithCustomError(pool, "NotCancelled");
    });
  });

  describe("Reentrancy", function () {
    it("malicious recipient cannot re-enter claim()", async function () {
      const { pool, alice, bob } = await loadFixture(deployOpen);
      const Attacker = await ethers.getContractFactory("ReentrantRecipient");
      const atk = await Attacker.deploy(await pool.getAddress());
      await pool.addProject("Evil", "", await atk.getAddress()); // id 3
      await pool.connect(alice).contribute(3, { value: E(1) });
      await pool.connect(bob).contribute(3, { value: E(1) });
      await time.increase(7 * DAY);
      await pool.finalize();
      // The nested claim() reverts (ReentrancyGuard), so the outer transfer fails.
      await expect(atk.attack(3)).to.be.revertedWithCustomError(pool, "TransferFailed");
      expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(E(12));
    });
  });
});
