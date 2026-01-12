import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import { DryRunPosition } from '../models/dryRun';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';

const USER_ADDRESS = ENV.USER_ADDRESS;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;

let temp_trades: UserActivityInterface[] = [];

const UserActivity = getUserActivityModel(USER_ADDRESS);

const readTempTrade = async () => {
    temp_trades = (
        await UserActivity.find({
            $and: [
                { type: 'TRADE' },
                { bot: false },
                {
                    $or: [
                        { botExcutedTime: { $exists: false } }, // New trades without botExcutedTime
                        { botExcutedTime: { $lt: RETRY_LIMIT } } // Retryable failed trades
                    ]
                }
            ],
        }).exec()
    ).map((trade) => trade as UserActivityInterface);
};

const doTrading = async (clobClient: ClobClient) => {
    for (const trade of temp_trades) {
        if (!ENV.LOG_ONLY_SUCCESS) {
            console.log('Trade to copy:', trade);
        }

        // Check if TITLE_FILTER is set and if the trade title includes it
        if (ENV.TITLE_FILTER && ENV.TITLE_FILTER.trim() !== '') {
            const filterText = ENV.TITLE_FILTER.toLowerCase();
            const tradeTitle = (trade.title || '').toLowerCase();

            if (!tradeTitle.includes(filterText)) {
                console.log(`Skipping trade: Title "${trade.title}" does not contain filter "${ENV.TITLE_FILTER}"`);

                // Mark as processed so we don't pick it up again
                await UserActivity.updateOne(
                    { _id: trade._id },
                    {
                        bot: true, // Mark as processed by bot
                        botExcutedTime: 100 // Set high retry count to prevent future retries
                    }
                );
                continue;
            }
        }

        // const market = await clobClient.getMarket(trade.conditionId);
        let my_positions: UserPositionInterface[] = [];
        if (ENV.DRY_RUN) {
            const simulatedPos = await DryRunPosition.findOne({ conditionId: trade.conditionId, outcome: trade.outcome });
            if (simulatedPos) {
                my_positions = [
                    {
                        conditionId: trade.conditionId,
                        asset: trade.asset,
                        size: simulatedPos.totalShares,
                    } as any,
                ];
            }
        } else {
            my_positions = await fetchData(`https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`);
        }

        const user_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );
        const my_position = my_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );
        const user_position = user_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );
        let my_balance = 0;
        let user_balance = 0;

        if (!ENV.DRY_RUN) {
            try {
                my_balance = await getMyBalance(PROXY_WALLET);
                user_balance = await getMyBalance(USER_ADDRESS);
            } catch (error) {
                console.error(`Error fetching balances from RPC:`, error);
                console.log(`Skipping trade due to RPC failure.`);
                continue;
            }
            console.log('My current balance:', my_balance);
            console.log('User current balance:', user_balance);
        } else {
            // For Dry Run, we use dummy balances
            my_balance = 1000000;
            user_balance = 1000000;
        }

        if (ENV.DRY_RUN) {
            // Dry Run: Only simulate BUY orders
            if (trade.side === 'BUY') {
                await postOrder(
                    clobClient,
                    trade.side.toLowerCase(),
                    my_position,
                    user_position,
                    trade,
                    my_balance,
                    user_balance
                );
            } else {
                console.log(`[DRY RUN] Skipping copying ${trade.side} for ${trade.title}. Market resolution will be tracked separately.`);
                // Mark as processed so we don't pick it up again
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            }
        } else {
            // Live mode: process all supported conditions
            await postOrder(
                clobClient,
                trade.side.toLowerCase(),
                my_position,
                user_position,
                trade,
                my_balance,
                user_balance
            );
        }
    }
};

const resolveMarketPositions = async (clobClient: ClobClient) => {
    // Filter out positions that are closed or missing conditionId
    const activePositions = await DryRunPosition.find({
        isClosed: { $ne: true },
        conditionId: { $exists: true, $ne: null }
    });

    if (activePositions.length === 0) return;

    console.log(`[DRY RUN] Checking resolution for ${activePositions.length} active positions via CLOB...`);

    // Group by conditionId to minimize API calls
    const marketIds = [...new Set(activePositions.map((p) => p.conditionId))].filter(id => !!id);

    for (const conditionId of marketIds) {
        try {
            const clobMarket = await clobClient.getMarket(conditionId);
            if (!clobMarket) continue;

            // Aggressive check: IF active is false OR closed is true
            const isResolved = clobMarket.closed === true || clobMarket.active === false;

            if (isResolved) {
                console.log(`\n[DRY RUN] Market Ended (ID: ${conditionId}): ${clobMarket.question || 'Unknown Market'}`);

                const marketPositions = activePositions.filter((p) => p.conditionId === conditionId);

                // Find winning outcome from tokens
                const winners = clobMarket.tokens.filter((t: any) => t.winner === true);

                if (winners.length > 0) {
                    const winningOutcome = winners[0].outcome; // Usually 'Up' or 'Down' or 'Yes' or 'No'
                    console.log(`Winning Outcome: ${winningOutcome}`);

                    for (const p of marketPositions) {
                        const won = p.outcome.toLowerCase() === winningOutcome.toLowerCase();
                        p.totalReturn = won ? p.totalShares : 0;
                        p.isClosed = true;
                        await p.save();
                        console.log(`  - Position ${p.outcome}: ${won ? '🏆 WON' : '❌ LOST'}`);
                    }
                } else {
                    console.log(`No winner declared yet in CLOB. Reporting current valuation if closed.`);
                    for (const p of marketPositions) {
                        p.totalReturn = 0;
                        p.isClosed = true;
                        await p.save();
                    }
                }

                // Print final summary
                await checkAndPrintSummary(clobMarket.question || 'Resolved Market', undefined, conditionId);
            }
        } catch (error: any) {
            console.error(`Error resolving market ${conditionId}:`, error.message || error);
        }
    }
};

const printOpenPositionsStatus = async () => {
    const activePositions = await DryRunPosition.find({ isClosed: false });
    if (activePositions.length === 0) return;

    console.log('\n--------------------------------------------------');
    console.log(`🕒 [DRY RUN STATUS] Open Positions (${new Date().toLocaleTimeString()})`);

    // Group by title for cleaner output
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
    console.log('--------------------------------------------------\n');
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
        // Returns are based on totalReturn (calculated in resolveMarketPositions)
        // or totalShares * exitPrice (if triggered by target sell)
        const botReturn = exitPrice !== undefined ? p.totalShares * exitPrice : p.totalReturn;
        const botPnL = botReturn - p.totalSpend;
        const botPnLPercent = p.totalSpend > 0 ? (botPnL / p.totalSpend) * 100 : 0;

        // Calculate Target PNL as well
        // For target, return is also shares * exitPrice or shares * 1/0
        const isResolution = exitPrice === undefined;
        let targetReturn = 0;
        if (isResolution) {
            // If p.totalReturn > 0 means it won (it's equal to totalShares)
            // So for target, return is 1 * targetTotalShares
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

        // Slippage Analysis
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

const tradeExcutor = async (clobClient: ClobClient) => {
    console.log(`Executing Copy Trading`);

    let lastResolveCheck = 0;

    while (true) {
        await readTempTrade();
        if (temp_trades.length > 0) {
            console.log('💥 New transactions found 💥');
            spinner.stop();
            await doTrading(clobClient);
        } else {
            spinner.start('Waiting for new transactions');
        }

        // Periodically check for market resolution and print status in Dry Run mode
        if (ENV.DRY_RUN && (Date.now() - lastResolveCheck > 60000)) {
            await resolveMarketPositions(clobClient);
            await printOpenPositionsStatus();
            lastResolveCheck = Date.now();
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

export default tradeExcutor;
