// Contract wiring (same structure as the Project Lab contract.js).
import ABI from "./abi.json";

// After deploying on Sepolia, set VITE_CONTRACT_ADDRESS in frontend/.env
// (or paste the address here).
export const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";

export const POOL_ABI = ABI;

export const SEPOLIA_CHAIN_ID = "0xaa36a7"; // 11155111
export const SEPOLIA_EXPLORER_URL = "https://sepolia.etherscan.io";

export const STATUS = ["Open", "Finalized", "Cancelled"];
