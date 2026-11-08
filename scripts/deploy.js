// Deploy QuadraPool and register demo projects.
//   npx hardhat run scripts/deploy.js --network sepolia
// Env (optional): ROUND_NAME, ROUND_MINUTES, MIN_CONTRIB_ETH, ALLOWLIST, SEED_MATCHING_ETH, RECIPIENTS
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const name = process.env.ROUND_NAME || "HKU Campus Public Goods Round";
  const minutes = Number(process.env.ROUND_MINUTES || 60 * 24 * 3); // default 3 days
  const minC = ethers.parseEther(process.env.MIN_CONTRIB_ETH || "0.0005");
  const allow = (process.env.ALLOWLIST || "false") === "true";
  const seed = process.env.SEED_MATCHING_ETH || "0";

  console.log(`Network ${network.name}, deployer ${deployer.address}`);
  console.log(`Balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const F = await ethers.getContractFactory("QuadraticFundingPool");
  const pool = await F.deploy(name, minutes * 60, minC, allow);
  await pool.waitForDeployment();
  const addr = await pool.getAddress();
  console.log("QuadraticFundingPool deployed at", addr);

  // Demo projects. v2: each project can have its own recipient, separate from the sponsor/deployer.
  //   RECIPIENTS=0xAAA...,0xBBB...,0xCCC...   (one per project, in order)
  // Fallback: DEMO_RECIPIENT (same for all), then the deployer.
  const demo = [
    ["Campus Water Refill Stations", "Reduce single-use plastic bottles on campus."],
    ["Open Lecture Notes Wiki", "Free, student-maintained notes for core courses."],
    ["Stray Cat Care Fund", "Food, neutering and vet visits for campus cats."],
  ];
  const list = (process.env.RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length > 0 && list.length !== demo.length) {
    throw new Error(`RECIPIENTS must list exactly ${demo.length} addresses, got ${list.length}`);
  }
  for (const a of list) {
    if (!ethers.isAddress(a)) throw new Error(`RECIPIENTS contains an invalid address: ${a}`);
  }
  for (let i = 0; i < demo.length; i++) {
    const [n, d] = demo[i];
    const r = list[i] || process.env.DEMO_RECIPIENT || deployer.address;
    if (r.toLowerCase() === deployer.address.toLowerCase()) {
      console.log(`  ! warning: "${n}" recipient is the deployer (sponsor). Set RECIPIENTS to separate roles.`);
    }
    const tx = await pool.addProject(n, d, r);
    await tx.wait();
    console.log(`  + project: ${n} -> recipient ${r}`);
  }
  if (Number(seed) > 0) {
    await (await pool.fundMatchingPool({ value: ethers.parseEther(seed) })).wait();
    console.log(`  + matching pool seeded with ${seed} ETH`);
  }

  const out = { network: network.name, address: addr, deployedAt: new Date().toISOString(), roundMinutes: minutes };
  fs.writeFileSync(path.join(__dirname, "..", "deployment.json"), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(__dirname, "..", "frontend", ".env"), `VITE_CONTRACT_ADDRESS=${addr}\n`);
  console.log("Wrote deployment.json and frontend/.env");
  if (network.name === "sepolia") {
    console.log(`Verify: npx hardhat verify --network sepolia ${addr} "${name}" ${minutes * 60} ${minC} ${allow}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
