# QuadraPool - Quadratic Funding Pool DApp

COMP7610 Introduction to Web3 and Blockchain (HKU, Section 2B, 2026) - Final Project

QuadraPool is a decentralized funding round for public-goods projects. Sponsors deposit ETH
into a **matching pool**; community members contribute ETH directly to projects; when the round
ends the matching pool is split with the **Quadratic Funding (CLR)** rule, so projects with
*many* supporters receive more matching than projects backed by a single large donor.

```
weight_p = (Σ_i √c_i)² − Σ_i c_i
match_p  = matchingPool × weight_p / Σ_q weight_q
```

## Features

| Area | What it does |
|---|---|
| Round lifecycle | Open → (endTime) → Finalized, or Cancelled by operator |
| Contributions | `contribute(projectId)` payable; repeat gifts from one address are merged (no split-payment gaming) |
| Matching | `fundMatchingPool()` by any sponsor; `finalize()` by anyone after `endTime` |
| Live preview | `previewContribution()` shows "your X ETH moves matching from A to B" before you sign |
| Payouts | Pull-based `claim()` for recipients; `refund()` / `refundSponsor()` after cancellation |
| Sybil resistance | Optional operator-managed allow-list (`setAllowlist`, `setAllowlistEnabled`) |
| Safety | Checks-Effects-Interactions, `ReentrancyGuard`, bounded loops (`MAX_PROJECTS = 20`), custom errors |

## Repository layout

```
contracts/QuadraticFundingPool.sol   main contract (OpenZeppelin Ownable, ReentrancyGuard, Math)
contracts/test/ReentrantRecipient.sol test-only attacker contract
test/QuadraticFundingPool.test.js    19 Hardhat tests (math vs. off-chain reference, Sybil, reentrancy...)
scripts/deploy.js                    deploy + register 3 demo projects, writes frontend/.env
scripts/experiment.js                experiments used in the report -> results/experiment.json
scripts/plot_results.py              figures -> results/fig*.png
frontend/                            React 19 + Vite + ethers v6 DApp (MetaMask, Sepolia)
```

## Prerequisites

- Node.js 20+ and npm; MetaMask browser extension
- A **testnet-only** MetaMask account with Sepolia ETH (e.g. Google Cloud Sepolia faucet)
- Python 3 with `matplotlib` (only to regenerate figures)

## 1. Install, compile, test

```bash
npm install
npx hardhat test          # 19 passing
```

## 2. Deploy to Sepolia

```bash
cp .env.example .env      # fill SEPOLIA_RPC_URL and PRIVATE_KEY (testnet account only!)
npx hardhat run scripts/deploy.js --network sepolia
```

The script prints the contract address, registers three demo projects, writes
`deployment.json` and `frontend/.env` (`VITE_CONTRACT_ADDRESS=...`).
`ROUND_MINUTES` controls the contribution window (use e.g. `30` to demo finalize quickly).

Optional verification on Etherscan: run the `npx hardhat verify ...` command printed by the script
(requires `ETHERSCAN_API_KEY`). Alternatively the contract can be deployed from Remix
(Injected Provider - MetaMask) and the address pasted into `frontend/.env`.

## 3. Run the frontend

```bash
cd frontend
npm install
npm run dev               # http://127.0.0.1:5173
```

Connect MetaMask (the app switches to Sepolia automatically). The deployer account sees the
**Operator panel** (add projects, allow-list, cancel, withdraw dust).

## 4. Demo script (multi-account)

1. In MetaMask create Accounts 2-6 and send each ~0.01 Sepolia ETH from Account 1.
2. Account 1 (operator) funds the matching pool.
3. Accounts 2-5 each give 0.002 ETH to project A; Account 6 gives 0.008 ETH to project B.
   Watch project A's matching share grow although both raised the same total.
4. **Sybil demo**: with the allow-list OFF one person's 5 accounts capture matching; turn the
   allow-list ON (only one address per person) and a new Sybil contribution reverts with
   `NotAllowlisted`.
5. After `endTime`, anyone clicks **Finalize**; recipients click **Claim**.

## 5. Reproduce experiments

```bash
npx hardhat run scripts/experiment.js
python scripts/plot_results.py
```

## Deployed contract

| Network | Address |
|---|---|
| Sepolia | see `deployment.json` (fill in after deployment) |

## Security notes and limitations

- The allow-list is a centralized trust assumption (the operator decides who is a unique human).
  Production systems use Gitcoin Passport / proof-of-personhood, or MACI against collusion.
- Contributions are public on-chain; bribery/collusion between donors is not prevented.
- `Math.sqrt` floors values; rounding dust (< number of projects, in wei) is withdrawable by the operator.
- Testnet only. Not audited.

## License

MIT
