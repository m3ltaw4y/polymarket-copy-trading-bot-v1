import { ethers } from 'ethers';
import axios from 'axios';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import { tradeEventEmitter } from '../utils/eventEmitter';
import { ChainDecoder } from '../utils/chainDecoder';

const USER_ADDRESS = ENV.USER_ADDRESS;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const PROXY_WALLET = ENV.PROXY_WALLET;
const TITLE_FILTER = ENV.TITLE_FILTER;
const RPC_URL = ENV.RPC_URL;
const USE_BLOCKCHAIN = ENV.USE_BLOCKCHAIN;

// ABIs - Minimal for filtering (Decoder handles the rest)
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xC5d563a36AE78145C45a50134d48A1215220f80a';

const UserActivity = getUserActivityModel(USER_ADDRESS);

// Helper to check title if needed
const fetchMarketTitle = async (assetId: string): Promise<string | null> => {
    try {
        // Use Data API or CLOB to get market info
        // CLOB Markets endpoint: https://clob.polymarket.com/markets/{token_id}
        const url = `${ENV.CLOB_HTTP_URL}markets/${assetId}`;
        const response = await axios.get(url);
        if (response.data && response.data.condition_id) {
            // CLOB returns question/market title in 'question' or 'market_slug'?
            // Actually, usually it returns the market object.
            // We can use the 'question' field as title approximation.
            return response.data.question || response.data.market_slug;
        }
    } catch (e) {
        // console.warn(`Failed to fetch title for asset ${assetId}`);
    }
    return null;
};

const processOnChainTrade = async (trade: any) => {
    try {
        // Deduplication (check if we already saved this tx)
        const exists = await UserActivity.findOne({ transactionHash: trade.transactionHash });
        if (exists) {
            return;
        }

        let title = "On-Chain Detected Trade";
        let shouldCopy = true;

        if (TITLE_FILTER) {
            // If filter is active, we MUST check the title
            const fetchedTitle = await fetchMarketTitle(trade.assetId);
            if (fetchedTitle) {
                title = fetchedTitle;
                if (!fetchedTitle.toLowerCase().includes(TITLE_FILTER.toLowerCase())) {
                    shouldCopy = false;
                    if (!ENV.LOG_ONLY_SUCCESS) console.log(`[CHAIN FILTER] Skipping trade for "${title}"`);
                }
            } else {
                // If we can't find title, we strictly abide by "Safety First"? 
                // Or "Speed First"?
                // Current decision: Skip if filter is ON and title is UNKNOWN.
                shouldCopy = false;
                console.log(`[CHAIN FILTER] Skipping unknown asset ${trade.assetId} (Title fetch failed)`);
            }
        }

        const newTrade = new UserActivity({
            transactionHash: trade.transactionHash,
            timestamp: Math.floor(trade.timestamp / 1000), // DB uses seconds
            type: 'TRADE',
            price: trade.price,
            size: trade.size,
            usdcSize: trade.usdcSpent,
            side: trade.side,
            asset: trade.assetId,
            symbol: trade.assetId, // Fallback
            title: title,
            outcome: "Unknown", // Can't easily map without API
            outcomeIndex: -1,
            proxyWallet: PROXY_WALLET,
            bot: !shouldCopy,
            source: 'BLOCKCHAIN' // Mark source
        });

        await newTrade.save();

        if (shouldCopy) {
            console.log(`🚀 Found new trade (CHAIN): ${trade.side} ${trade.size} @ ${trade.price?.toFixed(2)} [${trade.transactionHash.substring(0, 8)}]`);
            tradeEventEmitter.emit('newTrade');
        }

    } catch (e) {
        console.error("Error processing on-chain trade:", e);
    }
}
const processingHashes = new Set<string>();

const createProviderPool = (urls: string[]) => {
    return urls.map(url => ({
        url,
        provider: new ethers.providers.JsonRpcProvider(url.trim()),
        healthy: true,
        cooldownUntil: 0
    }));
};

const providers = createProviderPool(RPC_URL ? RPC_URL.split(',') : []);

/**
 * Races all healthy providers for the fastest response.
 */
const raceRpc = async <T>(fn: (p: ethers.providers.JsonRpcProvider) => Promise<T>): Promise<T> => {
    const now = Date.now();
    const healthyOnes = providers.filter(p => p.healthy && p.cooldownUntil < now);

    if (healthyOnes.length === 0) {
        // Reset cooldowns if all are dead to keep trying
        providers.forEach(p => { p.healthy = true; p.cooldownUntil = 0; });
        throw new Error("All RPC providers are in cooldown or unhealthy.");
    }

    return new Promise((resolve, reject) => {
        let completed = false;
        let errors = 0;

        healthyOnes.forEach(async (pInfo) => {
            try {
                const res = await fn(pInfo.provider);
                if (!completed) {
                    completed = true;
                    resolve(res);
                }
            } catch (e: any) {
                if (e.message.includes('Too many requests') || e.message.includes('429')) {
                    pInfo.cooldownUntil = Date.now() + 10000; // 10s timeout
                    console.warn(`[RPC] ${pInfo.url} rate limited. Cooling down...`);
                }
                errors++;
                if (errors >= healthyOnes.length && !completed) {
                    reject(new Error("All raced RPC calls failed."));
                }
            }
        });
    });
};

const initChainListener = () => {
    if (!USE_BLOCKCHAIN || providers.length === 0) return;

    console.log(`⛓️  Starting Parallel On-Chain Listener on ${providers.length} RPCs...`);
    const decoder = new ChainDecoder();

    providers.forEach(pInfo => {
        pInfo.provider.on("block", async (blockNumber) => {
            try {
                // Fetch block details (Racing)
                const block = await raceRpc(p => p.getBlockWithTransactions(blockNumber));
                if (!block || !block.transactions) return;

                // Better Filter: Check if User/Proxy is involved.
                const userTargetTxs = block.transactions.filter(tx => {
                    if (processingHashes.has(tx.hash)) return false;

                    // Direct
                    if (tx.from.toLowerCase() === USER_ADDRESS.toLowerCase() ||
                        (PROXY_WALLET && tx.from.toLowerCase() === PROXY_WALLET.toLowerCase())) return true;

                    // Meta-Tx (Data Scan)
                    const targetClean = USER_ADDRESS.toLowerCase().replace('0x', '');
                    const proxyClean = PROXY_WALLET?.toLowerCase().replace('0x', '');
                    if (tx.data) {
                        const d = tx.data.toLowerCase();
                        if (targetClean && d.includes(targetClean)) return true;
                        if (proxyClean && d.includes(proxyClean)) return true;
                    }
                    return false;
                });

                if (userTargetTxs.length > 0) {
                    for (const tx of userTargetTxs) {
                        if (processingHashes.has(tx.hash)) continue;
                        processingHashes.add(tx.hash);

                        try {
                            // Fetch Receipt (Racing)
                            const receipt = await raceRpc(p => p.getTransactionReceipt(tx.hash));
                            if (receipt) {
                                const decoded = decoder.decodeTrade(receipt, USER_ADDRESS, PROXY_WALLET || null);
                                if (decoded) {
                                    processOnChainTrade(decoded);
                                }
                            }
                        } catch (e: any) {
                            console.error(`[RPC] Receipt fetch failed for ${tx.hash.substring(0, 10)}:`, e.message || e);
                        } finally {
                            // Keep in cache for 60s to prevent redundant processing from other RPC block triggers
                            setTimeout(() => processingHashes.delete(tx.hash), 60000);
                        }
                    }
                }

            } catch (e: any) {
                // Racing might fail if all nodes are busy
            }
        });
    });
};

const init = async () => {
    await initChainListener();
};

const fetchTradeData = async () => {
    try {
        const url = `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=50&type=TRADE`; // Reduced limit for speed
        const activities = await fetchData(url);

        if (Array.isArray(activities)) {
            const now = Math.floor(Date.now() / 1000);
            const threshold = now - (TOO_OLD_TIMESTAMP * 60);

            for (const activity of activities) {
                if (activity.timestamp < threshold) continue;

                const exists = await UserActivity.findOne({ transactionHash: activity.transactionHash });
                if (!exists) {
                    let shouldCopy = true;
                    // Apply TITLE_FILTER
                    if (TITLE_FILTER && !activity.title.toLowerCase().includes(TITLE_FILTER.toLowerCase())) {
                        shouldCopy = false;
                        if (!ENV.LOG_ONLY_SUCCESS) {
                            console.log(`[FILTER] Skipping trade for "${activity.title}" (does not match filter)`);
                        }
                    }

                    const newTrade = new UserActivity({
                        ...activity,
                        bot: !shouldCopy,
                        proxyWallet: PROXY_WALLET,
                        source: 'API'
                    });
                    await newTrade.save();

                    if (shouldCopy) {
                        console.log(`Found new trade (API): ${activity.transactionHash.substring(0, 10)}... - ${activity.title}`);
                        tradeEventEmitter.emit('newTrade');
                    }
                }
            }
        }
    } catch (error: any) {
        console.error('Error in fetchTradeData:', error.message || error);
    }
};

const tradeMonitor = async () => {
    const intervalMs = Math.max(100, (FETCH_INTERVAL || 1) * 1000);
    console.log(`Trade Monitor is running every ${intervalMs}ms`);

    await init();
    while (true) {
        const startTime = Date.now();
        await fetchTradeData();
        const duration = Date.now() - startTime;
        const waitTime = Math.max(100, intervalMs - duration);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
};

export default tradeMonitor;
