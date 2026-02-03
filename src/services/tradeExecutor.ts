import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import { DryRunPosition } from '../models/dryRun';
import { DryRunStats } from '../models/dryRunStats';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';
import { tradeEventEmitter } from '../utils/eventEmitter';

const USER_ADDRESS = ENV.USER_ADDRESS;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;

let temp_trades: UserActivityInterface[] = [];

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserPosition = getUserPositionModel(USER_ADDRESS);
const MyPosition = getUserPositionModel(PROXY_WALLET);

let cachedMyBalance: number | undefined;
let cachedUserBalance: number | undefined;

const refreshBalances = async () => {
    try {
        cachedMyBalance = await getMyBalance(PROXY_WALLET);
        cachedUserBalance = await getMyBalance(USER_ADDRESS);
    } catch (error) {
        console.error('Failed to refresh balances:', error instanceof Error ? error.message : error);
    }
};

const readTempTrade = async () => {
    const query: any = {
        $and: [
            { type: 'TRADE' },
            { bot: false },
            {
                $or: [
                    { botExcutedTime: { $exists: false } },
                    { botExcutedTime: { $lt: RETRY_LIMIT } }
                ]
            }
        ],
    };

    if (ENV.TITLE_FILTER) {
        query.$and.push({ title: { $regex: ENV.TITLE_FILTER, $options: 'i' } });
    }

    const allPending = await UserActivity.find(query).sort({ timestamp: 1 }).lean().exec();

    if (allPending.length === 0) {
        temp_trades = [];
        return;
    }

    // Aggregate trades by (asset, side, outcome)
    const aggregated: Map<string, UserActivityInterface & { aggregatedIds: any[] }> = new Map();

    for (const trade of allPending) {
        if (!trade.side || !trade.asset || !trade.outcome) {
            console.warn(`[SKIP] Missing required fields for aggregation:`, trade.transactionHash);
            continue;
        }
        const key = `${trade.asset}_${trade.side.toLowerCase()}_${trade.outcome}`;

        if (aggregated.has(key)) {
            const existing = aggregated.get(key)!;

            // Calculate VWAP for the aggregate trade
            const totalSize = (existing.size || 0) + (trade.size || 0);
            const totalUsdc = (existing.usdcSize || 0) + (trade.usdcSize || 0);

            existing.price = totalSize > 0 ? totalUsdc / totalSize : 0;
            existing.size = totalSize;
            existing.usdcSize = totalUsdc;
            existing.timestamp = Math.max(existing.timestamp || 0, trade.timestamp || 0);
            existing.aggregatedIds.push(trade._id);
        } else {
            aggregated.set(key, {
                ...(trade as any),
                aggregatedIds: [trade._id]
            });
        }
    }

    temp_trades = Array.from(aggregated.values());

    if (temp_trades.length < allPending.length && !ENV.LOG_ONLY_SUCCESS) {
        console.log(`[AGGREGATION] Bundled ${allPending.length} trades into ${temp_trades.length} transactions.`);
    }
};

const doTrading = async (clobClient: ClobClient) => {
    for (const trade of temp_trades as (UserActivityInterface & { aggregatedIds?: any[] })[]) {
        if (!ENV.LOG_ONLY_SUCCESS) {
            console.log('Trade to copy:', trade);
        }

        let my_position: UserPositionInterface | undefined;
        let user_position: UserPositionInterface | undefined;
        let my_balance = 1000000;
        let user_balance = 1000000;

        const idsToUpdate = trade.aggregatedIds ? trade.aggregatedIds : [trade._id];

        if (!ENV.DRY_RUN) {
            try {
                if (cachedMyBalance === undefined || cachedUserBalance === undefined) {
                    await refreshBalances();
                }
                my_balance = cachedMyBalance ?? 1000000;
                user_balance = cachedUserBalance ?? 1000000;
                my_position = (await MyPosition.findOne({ asset: trade.asset })) as any;
                user_position = (await UserPosition.findOne({ asset: trade.asset })) as any;
            } catch (error) {
                console.error('Failed to fetch position:', error instanceof Error ? error.message : error);
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { $inc: { botExcutedTime: 1 } });
                continue;
            }
        }

        const side = trade.side || '';
        const condition = side.toLowerCase();

        if (condition === 'buy' || condition === 'sell' || condition === 'merge') {
            try {
                if (ENV.DRY_RUN && condition === 'merge') {
                    await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
                } else {
                    await postOrder(clobClient, condition, my_position, user_position, trade as any, my_balance, user_balance);
                    if (!ENV.DRY_RUN) {
                        await refreshBalances(); // Update cache after successful bet
                    }
                }
            } catch (error) {
                console.error(`Error processing trade ${trade.transactionHash}:`, error instanceof Error ? error.message : error);
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { $inc: { botExcutedTime: 1 } });
            }
        } else {
            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log(`[SKIP] Trade condition "${condition}" not supported for ${trade.transactionHash}`);
            }
            // Mark as handled anyway to prevent infinite loop
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
        }
    }
};

const resolveMarketPositions = async (clobClient: ClobClient) => {
    const query: any = {
        isClosed: { $ne: true },
        conditionId: { $exists: true, $ne: null }
    };
    if (ENV.TITLE_FILTER) {
        query.title = { $regex: ENV.TITLE_FILTER, $options: 'i' };
    }
    const activePositions = await DryRunPosition.find(query);

    if (activePositions.length === 0) return;

    if (!ENV.LOG_ONLY_SUCCESS) {
        console.log(`[DRY RUN] Checking resolution for ${activePositions.length} active positions via CLOB...`);
    }

    const marketIds = [...new Set(activePositions.map((p) => p.conditionId))].filter(id => !!id);

    // Parallelize market data fetching to prevent loop lag
    const marketDataResults = await Promise.all(marketIds.map(async (id) => {
        try {
            const clobMarket = await clobClient.getMarket(id);
            return { conditionId: id, clobMarket };
        } catch (error: any) {
            console.error(`Error fetching CLOB market ${id}:`, error.message || error);
            return { conditionId: id, clobMarket: null };
        }
    }));

    for (const { conditionId, clobMarket } of marketDataResults) {
        try {
            if (!clobMarket) continue;

            const isResolved = clobMarket.closed === true || clobMarket.active === false;

            if (isResolved) {
                console.log(`\n[DRY RUN] Market Ended (ID: ${conditionId}): ${clobMarket.question || 'Unknown Market'}`);

                const marketPositions = activePositions.filter((p) => p.conditionId === conditionId);
                const winners = clobMarket.tokens.filter((t: any) => t.winner === true);

                if (winners.length > 0) {
                    const winningOutcome = winners[0].outcome;
                    console.log(`Winning Outcome: ${winningOutcome}`);

                    // Get or create stats document
                    let stats = await DryRunStats.findOne();
                    if (!stats) {
                        stats = new DryRunStats();
                    }

                    for (const p of marketPositions) {
                        const won = p.outcome.toLowerCase() === winningOutcome.toLowerCase();
                        const targetReturn = won ? p.targetTotalShares : 0;

                        p.totalReturn = won ? p.totalShares : 0;
                        p.isClosed = true;
                        p.isWinner = won;
                        p.pnl = p.totalReturn - p.totalSpend;
                        await p.save();

                        // Update global stats - Bot
                        stats.totalSpend += p.totalSpend;
                        stats.totalReturns += p.totalReturn;

                        // Update global stats - Target
                        stats.targetTotalSpend += p.targetTotalSpend;
                        stats.targetTotalReturns += targetReturn;

                        if (won) {
                            stats.totalWins += p.totalReturn;
                            stats.winningPositions += 1;
                            console.log(`  - Position ${p.outcome}: 🏆 WON $${p.totalReturn.toFixed(2)} (Spent: $${p.totalSpend.toFixed(2)}, PnL: +$${p.pnl.toFixed(2)})`);
                        } else {
                            stats.totalLosses += p.totalSpend;
                            stats.losingPositions += 1;
                            console.log(`  - Position ${p.outcome}: ❌ LOST $${p.totalSpend.toFixed(2)} (PnL: -$${p.totalSpend.toFixed(2)})`);
                        }
                    }

                    stats.netPnL = stats.totalReturns - stats.totalSpend;
                    stats.targetNetPnL = stats.targetTotalReturns - stats.targetTotalSpend;
                    stats.lastUpdated = new Date();
                    await stats.save();
                } else {
                    console.log(`No winner declared yet in CLOB. Marking as closed (payout TBD).`);
                    for (const p of marketPositions) {
                        p.totalReturn = 0;
                        p.isClosed = true;
                        p.isWinner = false;
                        p.pnl = -p.totalSpend;
                        await p.save();
                    }
                }
                await checkAndPrintSummary(clobMarket.question || 'Resolved Market', undefined, conditionId);
            }
        } catch (error: any) {
            console.error(`Error resolving market ${conditionId}:`, error.message || error);
        }
    }
};

const printOpenPositionsStatus = async () => {
    const query: any = { isClosed: false };
    if (ENV.TITLE_FILTER) {
        query.title = { $regex: ENV.TITLE_FILTER, $options: 'i' };
    }
    const activePositions = await DryRunPosition.find(query);

    console.log('\n==================================================');
    console.log(`🕒 [DRY RUN STATUS] (${new Date().toLocaleTimeString()})`);
    console.log('==================================================');

    // Display running tally
    const stats = await DryRunStats.findOne();
    if (stats) {
        const winRate = stats.winningPositions + stats.losingPositions > 0
            ? (stats.winningPositions / (stats.winningPositions + stats.losingPositions) * 100)
            : 0;

        console.log('\n📊 CUMULATIVE STATISTICS (All Markets)');
        console.log('--------------------------------------------------');

        // Bot Performance
        console.log('YOUR BOT:');
        console.log(`  Total Spent:        $${stats.totalSpend.toFixed(2)}`);
        console.log(`  Total Returns:      $${stats.totalReturns.toFixed(2)}`);
        console.log(`  Net P&L:            ${stats.netPnL >= 0 ? '+' : ''}$${stats.netPnL.toFixed(2)} (${stats.totalSpend > 0 ? ((stats.netPnL / stats.totalSpend) * 100).toFixed(2) : '0.00'}%)`);
        console.log(`  Winning Positions:  ${stats.winningPositions} (Total Wins: $${stats.totalWins.toFixed(2)})`);
        console.log(`  Losing Positions:   ${stats.losingPositions} (Total Losses: $${stats.totalLosses.toFixed(2)})`);
        console.log(`  Win Rate:           ${winRate.toFixed(2)}%`);

        // Target Performance
        console.log('\nTARGET ACCOUNT:');
        console.log(`  Total Spent:        $${stats.targetTotalSpend.toFixed(2)}`);
        console.log(`  Total Returns:      $${stats.targetTotalReturns.toFixed(2)}`);
        console.log(`  Net P&L:            ${stats.targetNetPnL >= 0 ? '+' : ''}$${stats.targetNetPnL.toFixed(2)} (${stats.targetTotalSpend > 0 ? ((stats.targetNetPnL / stats.targetTotalSpend) * 100).toFixed(2) : '0.00'}%)`);

        // Comparison
        const pnlDiff = stats.netPnL - stats.targetNetPnL;
        const pnlDiffPercent = stats.targetNetPnL !== 0 ? ((pnlDiff / Math.abs(stats.targetNetPnL)) * 100) : 0;
        console.log('\nCOMPARISON (Bot vs Target):');
        console.log(`  P&L Difference:     ${pnlDiff >= 0 ? '+' : ''}$${pnlDiff.toFixed(2)} (${pnlDiff >= 0 ? '✅' : '⚠️'} ${pnlDiffPercent >= 0 ? '+' : ''}${pnlDiffPercent.toFixed(2)}%)`);

        if (stats.largestMarketSpend > 0) {
            console.log(`\n💰 PEAK CAPITAL REQUIREMENT:`);
            console.log(`  Largest Market:     $${stats.largestMarketSpend.toFixed(2)}`);
            console.log(`  Market:             ${stats.largestMarketTitle}`);
        }
        console.log('--------------------------------------------------\n');
    }

    // Display open positions
    if (activePositions.length > 0) {
        console.log(`📈 OPEN POSITIONS (${activePositions.length})`);
        console.log('--------------------------------------------------');

        const groups: { [key: string]: typeof activePositions } = {};
        activePositions.forEach(p => {
            if (!groups[p.title]) groups[p.title] = [];
            groups[p.title].push(p);
        });

        for (const title in groups) {
            console.log(`Market: ${title}`);
            groups[title].forEach(p => {
                console.log(`  - ${p.outcome}:`);
                console.log(`    Target: Spent $${(p.targetTotalSpend || 0).toFixed(2)} (Shares: ${(p.targetTotalShares || 0).toFixed(2)} | Avg: $${(p.targetAvgPrice || 0).toFixed(4)})`);
                console.log(`    Bot   : Spent $${(p.totalSpend || 0).toFixed(2)} (Shares: ${(p.totalShares || 0).toFixed(2)} | Avg: $${(p.avgPrice || 0).toFixed(4)})`);
            });
        }
    } else {
        console.log('📈 OPEN POSITIONS: None');
    }

    console.log('==================================================\n');
};

const checkAndPrintSummary = async (title: string, exitPrice?: number, conditionId?: string) => {
    const query = conditionId ? { conditionId } : { title };
    const positions = await DryRunPosition.find(query);
    if (positions.length === 0) return;

    console.log(`\n==================================================`);
    console.log(`📊 [DRY RUN PERFORMANCE SUMMARY]`);
    console.log(`Market: ${title}`);
    console.log(`==================================================`);

    let totalSpendAll = 0;
    let totalReturnAll = 0;
    let totalTargetSpendAll = 0;
    let totalTargetReturnAll = 0;

    for (const p of positions) {
        const botReturn = exitPrice !== undefined ? p.totalShares * exitPrice : p.totalReturn;
        const botPnL = botReturn - p.totalSpend;
        const botPnLPercent = p.totalSpend > 0 ? (botPnL / p.totalSpend) * 100 : 0;

        const isResolution = exitPrice === undefined;
        let targetReturn = 0;
        if (isResolution) {
            targetReturn = p.totalReturn > 0 ? p.targetTotalShares : 0;
        } else {
            targetReturn = p.targetTotalShares * exitPrice!;
        }

        const targetPnL = targetReturn - p.targetTotalSpend;
        const targetPnLPercent = p.targetTotalSpend > 0 ? (targetPnL / p.targetTotalSpend) * 100 : 0;

        console.log(`Outcome: ${p.outcome}`);
        console.log(`  --- TARGET ACCOUNT ---`);
        console.log(`  Spent:       $${p.targetTotalSpend.toFixed(2)} (Shares: ${p.targetTotalShares.toFixed(2)})`);
        console.log(`  Avg Price:   $${p.targetAvgPrice.toFixed(4)}`);
        console.log(`  Return:      $${targetReturn.toFixed(2)}`);
        console.log(`  PnL:         $${targetPnL.toFixed(2)} (${targetPnLPercent.toFixed(2)}%)`);

        console.log(`  --- YOUR BOT (DRY RUN) ---`);
        console.log(`  Spent:       $${p.totalSpend.toFixed(2)} (Shares: ${p.totalShares.toFixed(2)})`);
        console.log(`  Avg Price:   $${p.avgPrice.toFixed(4)}`);
        console.log(`  Return:      $${botReturn.toFixed(2)}`);
        console.log(`  PnL:         $${botPnL.toFixed(2)} (${botPnLPercent.toFixed(2)}%)`);

        const priceDiff = p.avgPrice - p.targetAvgPrice;
        const slippagePercent = p.targetAvgPrice > 0 ? (priceDiff / p.targetAvgPrice) * 100 : 0;
        console.log(`  --- SLIPPAGE ANALYSIS ---`);
        console.log(`  Price Diff:  $${priceDiff.toFixed(4)} (${slippagePercent.toFixed(2)}% ${priceDiff > 0 ? 'WORSE' : 'BETTER'})`);

        totalSpendAll += p.totalSpend;
        totalReturnAll += botReturn;
        totalTargetSpendAll += p.targetTotalSpend;
        totalTargetReturnAll += targetReturn;
    }

    if (positions.length > 1) {
        const totalPnL = totalReturnAll - totalSpendAll;
        const totalPnLPercent = totalSpendAll > 0 ? (totalPnL / totalSpendAll) * 100 : 0;

        const totalTargetPnL = totalTargetReturnAll - totalTargetSpendAll;
        const totalTargetPnLPercent = totalTargetSpendAll > 0 ? (totalTargetPnL / totalTargetSpendAll) * 100 : 0;

        console.log('--------------------------------------------------');
        console.log(`Combined Totals:`);
        console.log(`  Target PnL:  $${totalTargetPnL.toFixed(2)} (${totalTargetPnLPercent.toFixed(2)}%)`);
        console.log(`  Your PnL:    $${totalPnL.toFixed(2)} (${totalPnLPercent.toFixed(2)}%)`);
        console.log(`  Profit Diff: $${(totalPnL - totalTargetPnL).toFixed(2)}`);
    }
    console.log('==================================================\n');
};

let isTrading = false;

const triggerTrading = async (clobClient: ClobClient) => {
    if (isTrading) return;
    isTrading = true;
    try {
        await readTempTrade();
        if (temp_trades.length > 0) {
            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log('💥 New transactions found 💥');
            }
            spinner.stop();
            await doTrading(clobClient);
        }
    } catch (e) {
        console.error('Error in triggerTrading:', e);
    } finally {
        isTrading = false;
    }
};

const tradeExecutor = async (clobClient: ClobClient) => {
    console.log(`Executor initialized. Waiting for trades...`);

    if (!ENV.DRY_RUN) {
        await refreshBalances();
    }

    // Listen for immediate events from monitor
    tradeEventEmitter.on('newTrade', () => {
        triggerTrading(clobClient);
    });

    let lastResolveCheck = 0;

    while (true) {
        // Periodically check for market resolution and print status in Dry Run mode FIRST
        if (ENV.DRY_RUN && (Date.now() - lastResolveCheck >= 60000)) {
            await resolveMarketPositions(clobClient);
            await printOpenPositionsStatus();
            lastResolveCheck = Date.now();
        }

        // Fallback check every loop iteration (1s)
        await triggerTrading(clobClient);

        if (!isTrading) {
            spinner.start('Waiting for new transactions');
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

export default tradeExecutor;
