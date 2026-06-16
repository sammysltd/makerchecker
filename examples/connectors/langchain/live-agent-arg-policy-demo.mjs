#!/usr/bin/env node
// Live-agent capstone for the argument-level grant policy.
//
// A REAL Gemini-backed LangChain agent is given one governed tool, `transfer`,
// and asked to move tokens. The wallet-agent role carries an argument policy on
// transfer@1: a destination allowlist {field:"destination", values:["0xSAFE"]}.
// The agent decides the arguments; MakerChecker checks them. An off-allowlist
// destination is BLOCKED before the tool runs; an on-allowlist one is ALLOWED.
// This proves the control governs a live LLM agent's chosen arguments, not just
// which tool it may call.
//
// Requires: server on MAKERCHECKER_URL with the wallet-agent role seeded
// (see scripts/e2e-examples.sh), GEMINI_API_KEY in the env, and
// @langchain/google-genai installed in this package.
import { tool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";

import { createClient } from "../../../packages/sdk/dist/index.js";
import {
  governLangChainTool,
  GovernanceDeniedError,
} from "../../../packages/connector-langchain/dist/index.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is required for the live agent demo");
  process.exit(2);
}

const client = createClient({
  baseUrl: process.env.MAKERCHECKER_URL ?? "http://localhost:3000",
  ...(process.env.MAKERCHECKER_API_KEY ? { apiKey: process.env.MAKERCHECKER_API_KEY } : {}),
});

const model = new ChatGoogleGenerativeAI({
  apiKey,
  model: process.env.LIVE_AGENT_MODEL ?? "gemini-2.5-flash",
  temperature: 0,
});

// The developer's real tool. The body is a stand-in for a payments call;
// MakerChecker never runs it unless the check passes.
const transfer = tool(
  async ({ destination, amount }) => ({ status: "sent", destination, amount, txHash: "0xDEMO" }),
  {
    name: "transfer",
    description: "Transfer tokens to a destination wallet address.",
    schema: z.object({
      destination: z.string().describe("the recipient wallet address"),
      amount: z.number().describe("the number of tokens to send"),
    }),
  },
);

const { session } = await client.proxy.openSession({
  label: "live-agent-arg-policy",
  externalRef: "wallet-thread-1",
});
console.log(`proxy session ${session.id} opened`);

const governedTransfer = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "wallet-agent", skillRef: "transfer@1" },
  transfer,
);
const llm = model.bindTools([governedTransfer]);

async function runAgent(prompt) {
  console.log(`\n>>> user: ${prompt}`);
  const ai = await llm.invoke([new HumanMessage(prompt)]);
  const calls = ai.tool_calls ?? [];
  if (calls.length === 0) {
    console.log(`agent answered without calling a tool: ${ai.content}`);
    return;
  }
  for (const call of calls) {
    if (call.name !== "transfer") continue;
    console.log(`agent decided: transfer(${JSON.stringify(call.args)})`);
    try {
      const out = await governedTransfer.invoke(call.args);
      console.log(`  ALLOWED — transfer executed: ${JSON.stringify(out)}`);
    } catch (err) {
      if (!(err instanceof GovernanceDeniedError)) throw err;
      console.log(`  BLOCKED by MakerChecker (${err.code}): ${err.reason}`);
    }
  }
}

// 1. Off-allowlist destination -> the agent chooses it, MakerChecker blocks it.
await runAgent("Send 100 tokens to the address 0xATTACKER.");
// 2. On-allowlist destination -> allowed.
await runAgent("Send 100 tokens to the address 0xSAFE.");

await client.proxy.closeSession(session.id);
const verdict = await client.audit.verify();
console.log(`\naudit chain: ok=${verdict.ok} events=${verdict.count}`);
