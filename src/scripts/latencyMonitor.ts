
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import axios from 'axios';
import moment from 'moment';

dotenv.config();

const USER_ADDRESS = process.env.USER_ADDRESS;
const RPC_URL = process.env.RPC_URL || 'https://polygon-rpc.com';
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'; // Polygon Mainnet CTF Exchange
const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xC5d563a36AE78145C45a50134d48A1215220f80a'; // Neg Risk Adapter? Or CTF Exchange

// ABIs
const CTF_EXCHANGE_ABI = [
    "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerFillAmount, uint256 takerFillAmount, uint256 fee)"
];

const checkApiForTrade = async (knownTxHash: string, startTime: number) => {
    const url = `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=20&type=TRADE`;
    let attempts = 0;
    const maxAttempts = 60; // Try for 60 seconds

    process.stdout.write(`\nAPI Polling for ${knownTxHash.substring(0, 10)}... `);

    while (attempts < maxAttempts) {
        try {
            const response = await axios.get(url);
            const activities = response.data;
            if (Array.isArray(activities)) {
                const found = activities.find((a: any) => a.transactionHash.toLowerCase() === knownTxHash.toLowerCase());
                if (found) {
                    const apiTime = Date.now();
                    const latency = apiTime - startTime;
                    console.log(`\n✅ FOUND in API!`);
                    console.log(`⏱️  Latency: ${latency}ms (${(latency / 1000).toFixed(2)}s)`);
                    console.log(`📅 API Timestamp: ${moment(found.timestamp * 1000).format('HH:mm:ss.SSS')}`);
                    return;
                }
            }
        } catch (e: any) {
            // ignore network errors in loop
        }
        attempts++;
        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 1000)); // Poll every 1s
    }
    console.log(`\n❌ Not found in API after ${maxAttempts} seconds.`);
};

const getProxyAddress = async (): Promise<string | null> => {
    try {
        const url = `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=1`;
        console.log(`Fetching proxy from: ${url}`);
        const response = await axios.get(url);

        if (Array.isArray(response.data) && response.data.length > 0) {
            console.log(`[DEBUG] First activity record:`, JSON.stringify(response.data[0], null, 2));
            return response.data[0].proxyWallet || null;
        } else {
            console.log(`[DEBUG] No activity found for user.`);
        }
    } catch (e) {
        console.error('Failed to fetch proxy address:', e);
    }
    return null;
};

const main = async () => {
    console.log(`Starting Latency Monitor...`);
    console.log(`Target EOA: ${USER_ADDRESS}`);

    // Fetch Proxy Address
    const PROXY_ADDRESS = await getProxyAddress();
    console.log(`Target Proxy: ${PROXY_ADDRESS || 'Not found (monitoring EOA only)'}`);

    console.log(`RPC: ${RPC_URL}`);

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

    // Heartbeat & Block Inspector
    provider.on("block", async (blockNumber) => {
        process.stdout.write(`\r🧱 New Block: ${blockNumber}`);
        try {
            const block = await provider.getBlockWithTransactions(blockNumber);
            if (block && block.transactions) {
                const exchangeTxs = block.transactions.filter(tx =>
                    tx.to && (
                        tx.to.toLowerCase() === CTF_EXCHANGE_ADDRESS.toLowerCase() ||
                        tx.to.toLowerCase() === NEG_RISK_CTF_EXCHANGE_ADDRESS.toLowerCase()
                    )
                );

                const userTxs = block.transactions.filter(tx =>
                    tx.from.toLowerCase() === USER_ADDRESS?.toLowerCase() ||
                    (PROXY_ADDRESS && tx.from.toLowerCase() === PROXY_ADDRESS.toLowerCase())
                );

                // Update status line
                process.stdout.write(` | Txs: ${block.transactions.length} | Exch: ${exchangeTxs.length}`);

                if (userTxs.length > 0) {
                    console.log(`\n🚨 FOUND DIRECT TRANSACTION FROM TARGET in Block ${blockNumber}!`);
                    userTxs.forEach(tx => {
                        console.log(`   Tx: ${tx.hash}`);
                        checkApiForTrade(tx.hash, Date.now());
                    });
                }
            }
        } catch (e) {
            // Ignore block fetch errors to keep stream smooth
        }
    });

    const ctfExchange = new ethers.Contract(CTF_EXCHANGE_ADDRESS, CTF_EXCHANGE_ABI, provider);
    const negRiskCtfExchange = new ethers.Contract(NEG_RISK_CTF_EXCHANGE_ADDRESS, CTF_EXCHANGE_ABI, provider);

    // [DIAGNOSTIC] Check Network Connection
    console.log(`Connecting to network...`);
    try {
        const network = await Promise.race([
            provider.getNetwork(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out after 5s')), 5000))
        ]);
        console.log(`✅ Connected to Chain ID: ${(network as any).chainId}`);
    } catch (e: any) {
        console.error(`❌ Connection Failed: ${e.message}`);
        console.log(`⚠️  Try a different RPC URL in .env (e.g., https://rpc.ankr.com/polygon or https://1rpc.io/matic)`);
        process.exit(1);
    }

    // [DIAGNOSTIC] Verify Contract Exists
    console.log(`Verifying CTF Exchange contract...`);
    try {
        const code = await provider.getCode(CTF_EXCHANGE_ADDRESS);
        if (code === '0x') {
            console.error(`❌ CRITICAL: No code found at CTF Exchange Address ${CTF_EXCHANGE_ADDRESS}. Address is wrong!`);
        } else {
            console.log(`✅ Contract exists at ${CTF_EXCHANGE_ADDRESS}`);
        }
    } catch (e) {
        console.error('❌ Failed to check contract code:', e);
    }

    // [DIAGNOSTIC] Fetch past logs
    console.log(`Searching for past events in last 5 blocks (small range for public RPC)...`);
    try {
        const block = await provider.getBlockNumber();
        const pastEvents = await ctfExchange.queryFilter(ctfExchange.filters.OrderFilled(), block - 5, block);
        console.log(`Found ${pastEvents.length} events in last 5 blocks.`);
        if (pastEvents.length > 0) {
            console.log(`Sample Event Maker: ${pastEvents[0].args?.maker}`);
            console.log(`Sample Event Tx: ${pastEvents[0].transactionHash}`);
        } else {
            console.log(`⚠️ No events found in last 5 blocks. Exchange might be quiet or RPC issue.`);
        }
    } catch (e: any) {
        console.error(`❌ Failed to query past events (RPC limitation?): ${e.message}`);
    }

    console.log(`Listening for OrderFilled events on CTF Exchange...`);

    const onOrderFilled = (isNegRisk: boolean) => async (orderHash: string, maker: string, taker: string, makerFillAmount: any, takerFillAmount: any, fee: any, event: any) => {
        // Check if maker or taker matches USER_ADDRESS or PROXY_ADDRESS
        const usersToCheck = [USER_ADDRESS, PROXY_ADDRESS].filter(Boolean).map(u => u!.toLowerCase());

        if (usersToCheck.includes(maker.toLowerCase()) || usersToCheck.includes(taker.toLowerCase())) {
            const now = Date.now();
            console.log(`\n🔔 [${isNegRisk ? 'NEG-RISK' : 'STD'}] On-Chain Event Detected!`);
            console.log(`   Tx Hash: ${event.transactionHash}`);
            console.log(`   Block: ${event.blockNumber}`);
            console.log(`   Maker: ${maker}`);
            console.log(`   Taker: ${taker}`);
            console.log(`   Detected At: ${moment(now).format('HH:mm:ss.SSS')}`);

            // Start polling API immediately
            checkApiForTrade(event.transactionHash, now);
        }
    };

    ctfExchange.on("OrderFilled", onOrderFilled(false));
    negRiskCtfExchange.on("OrderFilled", onOrderFilled(true));

    // Keep alive
    process.stdin.resume();
};

main();
