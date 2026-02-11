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

// Title cache to avoid redundant API calls
const titleCache = new Map<string, string>();
const TITLE_CACHE_TTL = 3600000; // 1 hour in milliseconds
const titleCacheTimestamps = new Map<string, number>();

// Helper to check title if needed
const fetchMarketTitle = async (assetId: string): Promise<string | null> => {
    // Check cache first
    const now = Date.now();
    const cached = titleCache.get(assetId);
    const cacheTime = titleCacheTimestamps.get(assetId);

    if (cached && cacheTime && (now - cacheTime < TITLE_CACHE_TTL)) {
        return cached;
    }

    try {
        // 1. Try CLOB API (Fastest for standard markets)
        const clobUrl = `${ENV.CLOB_HTTP_URL}markets/${assetId}`;
        try {
            const resp = await axios.get(clobUrl, { timeout: 3000 });
            if (resp.data && resp.data.question) {
                const title = resp.data.question;
                titleCache.set(assetId, title);
                titleCacheTimestamps.set(assetId, now);
                return title;
            }
        } catch (e: any) {
            // CLOB 404 is common for Neg Risk, continue to next
        }

        // 2. Try Gamma API - Method 1: Direct find by token ID
        try {
            const gammaUrl = `https://gamma-api.polymarket.com/events?find=${assetId}`;
            const gammaResp = await axios.get(gammaUrl, { timeout: 3000 });
            if (gammaResp.data && gammaResp.data.length > 0) {
                const title = gammaResp.data[0].title || gammaResp.data[0].question;
                if (title) {
                    titleCache.set(assetId, title);
                    titleCacheTimestamps.set(assetId, now);
                    return title;
                }
            }
        } catch (e) {
            // Continue to next fallback
        }

        // 3. Try Gamma API - Method 2: Search markets by token ID in outcomes
        try {
            const gammaMarketsUrl = `https://gamma-api.polymarket.com/markets?closed=false&limit=100`;
            const marketsResp = await axios.get(gammaMarketsUrl, { timeout: 5000 });
            if (marketsResp.data && Array.isArray(marketsResp.data)) {
                for (const market of marketsResp.data) {
                    if (market.tokens && market.tokens.some((t: any) => t.token_id === assetId)) {
                        const title = market.question || market.title;
                        if (title) {
                            titleCache.set(assetId, title);
                            titleCacheTimestamps.set(assetId, now);
                            return title;
                        }
                    }
                }
            }
        } catch (e) {
            // Final fallback failed
        }

    } catch (e) {
        // All lookups failed
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
            const fetchedTitle = await fetchMarketTitle(trade.assetId);
            if (fetchedTitle) {
                title = fetchedTitle;
                if (!fetchedTitle.toLowerCase().includes(TITLE_FILTER.toLowerCase())) {
                    shouldCopy = false;
                    if (!ENV.LOG_ONLY_SUCCESS) console.log(`[CHAIN FILTER] Skipping trade for "${title}"`);
                }
            } else {
                // CRITICAL: We MUST save this trade to DB even if we can't resolve the title.
                // The hash is already in processingHashes, so if we return here, the API poll
                // will also skip it, causing the trade to be permanently lost.
                // Instead, mark it as bot=true (skip) and save it, so at least it's recorded.
                shouldCopy = false;
                if (!ENV.LOG_ONLY_SUCCESS) console.log(`[CHAIN] Unknown title for ${trade.assetId.substring(0, 10)}... saving with skip flag.`);
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
};
const processingHashes = new Set<string>();
const processingBlocks = new Set<number>();

const createProviderPool = (urls: string[]) => {
    return urls.map(url => ({
        url,
        provider: new ethers.providers.JsonRpcProvider(url.trim()),
        healthy: true,
        cooldownUntil: 0,
        lastLoggedError: 0
    }));
};

const providers = createProviderPool(RPC_URL ? RPC_URL.split(',') : []);

const LOG_ONLY_SUCCESS = ENV.LOG_ONLY_SUCCESS;

/**
 * Races healthy providers for the fastest response.
 * Limits the race to the first 5 healthy nodes to avoid over-requesting public nodes.
 */
const raceRpc = async <T>(fn: (p: ethers.providers.JsonRpcProvider) => Promise<T>): Promise<T> => {
    const now = Date.now();
    let healthyOnes = providers.filter(p => p.healthy && (p.cooldownUntil === 0 || p.cooldownUntil < now));

    if (healthyOnes.length === 0) {
        providers.forEach(p => { p.healthy = true; p.cooldownUntil = 0; });
        healthyOnes = providers;
    }

    // Swarm protection: Only race the first 5 healthy nodes
    const raceSubset = healthyOnes.slice(0, 5);

    return new Promise((resolve, reject) => {
        let completed = false;
        let errors = 0;

        raceSubset.forEach(async (pInfo) => {
            try {
                const res = await fn(pInfo.provider);
                if (!completed) {
                    completed = true;
                    resolve(res);
                }
            } catch (e: any) {
                if (e.message.includes('Too many requests') || e.message.includes('429')) {
                    pInfo.cooldownUntil = Date.now() + 60000; // 60s cooldown
                    if (!LOG_ONLY_SUCCESS && (Date.now() - pInfo.lastLoggedError > 60000)) {
                        console.warn(`[RPC] ${pInfo.url} rate limited. Cooling down...`);
                        pInfo.lastLoggedError = Date.now();
                    }
                }
                errors++;
                if (errors >= raceSubset.length && !completed) {
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
            // Deduplicate block processing: Ensure only one race happens per block height
            if (processingBlocks.has(blockNumber)) return;
            processingBlocks.add(blockNumber);
            setTimeout(() => processingBlocks.delete(blockNumber), 30000); // 30s cache

            try {
                // Fetch block details (Racing)
                const block = await raceRpc(p => p.getBlockWithTransactions(blockNumber));
                if (!block || !block.transactions) return;

                if (!ENV.LOG_ONLY_SUCCESS && blockNumber % 10 === 0) {
                    console.log(`[BLOCK] ${blockNumber} raced successfully.`);
                }

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
        const now = Math.floor(Date.now() / 1000);
        const threshold = now - (TOO_OLD_TIMESTAMP * 60);

        let offset = 0;
        const limit = 1000; // Maximum per request
        let totalFetched = 0;
        let totalProcessed = 0;

        while (true) {
            const url = `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=${limit}&offset=${offset}&type=TRADE`;
            const activities = await fetchData(url);

            if (!Array.isArray(activities) || activities.length === 0) {
                // No more trades available
                break;
            }

            totalFetched += activities.length;
            let hitOldThreshold = false;

            for (const activity of activities) {
                // Stop processing if we've reached trades older than threshold
                if (activity.timestamp < threshold) {
                    hitOldThreshold = true;
                    break;
                }

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
                    totalProcessed++;

                    if (shouldCopy) {
                        console.log(`Found new trade (API): ${activity.transactionHash.substring(0, 10)}... - ${activity.title}`);
                        tradeEventEmitter.emit('newTrade');
                    }
                }
            }

            // Stop pagination if we hit old trades or got fewer than requested (end of list)
            if (hitOldThreshold || activities.length < limit) {
                if (!ENV.LOG_ONLY_SUCCESS && totalFetched > 0) {
                    console.log(`[API FETCH] Completed. Fetched ${totalFetched} trades, processed ${totalProcessed} new ones.`);
                }
                break;
            }

            // Continue to next page
            offset += limit;
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
