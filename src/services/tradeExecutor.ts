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

const resolveMarketPositions = async () => {
    // Filter out positions that are closed or missing conditionId
    const activePositions = await DryRunPosition.find({
        isClosed: { $ne: true },
        conditionId: { $exists: true, $ne: null }
    });

    if (activePositions.length === 0) return;

    // Group by conditionId to minimize API calls
    const marketIds = [...new Set(activePositions.map((p) => p.conditionId))].filter(id => !!id);

    for (const conditionId of marketIds) {
        try {
            // Try conditionId parameter (most common in modern Gamma API)
            const url = `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`;
            const markets = await fetchData(url);
            if (!markets || !Array.isArray(markets) || markets.length === 0) continue;

            const market = markets.find(m => m.conditionId === conditionId || m.condition_id === conditionId);
            if (!market) {
                // Not found or ID mismatch (preventing generic Joe Biden fallback)
                continue;
            }

            // Apply TITLE_FILTER to resolution logic as well
            if (ENV.TITLE_FILTER && ENV.TITLE_FILTER.trim() !== '') {
                const filterText = ENV.TITLE_FILTER.toLowerCase();
                const marketTitle = (market.question || '').toLowerCase();
                if (!marketTitle.includes(filterText)) {
                    continue; // Skip markets that don't match the current filter
                }
            }

            if (market.closed === true) {
                console.log(`\n[DRY RUN] Market Resolved (ID: ${conditionId}): ${market.question || 'Unknown Market'}`);

                // Determine winning outcome index
                // Note: outcomePrices can sometimes be a stringified array in certain API versions
                let prices = market.outcomePrices;
                if (typeof prices === 'string') {
                    try { prices = JSON.parse(prices); } catch (e) {
                        // Fallback for simple scalar strings if they exist
                        prices = [prices];
                    }
                }

                if (!Array.isArray(prices)) {
                    console.error(`Could not parse outcomePrices for ${conditionId}:`, market.outcomePrices);
                    continue;
                }

                const winningIndex = prices.findIndex((p: any) => p === "1" || p === "1.0" || p === 1);

                if (winningIndex !== -1 && market.outcomes) {
                    const winningOutcome = market.outcomes[winningIndex];
                    console.log(`Winning Outcome: ${winningOutcome}`);

                    const marketPositions = activePositions.filter((p) => p.conditionId === conditionId);

                    for (const p of marketPositions) {
                        const won = p.outcome.toLowerCase() === winningOutcome.toLowerCase();
                        const finalReturn = won ? p.totalShares : 0;

                        console.log(`Outcome ${p.outcome}: ${won ? '🏆 WON' : '❌ LOST'}`);

                        // Update position with final result
                        p.totalReturn = finalReturn;
                        p.isClosed = true;
                        await p.save();
                    }

                    // Print final summary for this market
                    await checkAndPrintSummary(market.question || 'Resolved Market', undefined, conditionId);
                } else {
                    console.log(`[DRY RUN] Market ${conditionId} closed but no clear winner found yet.`);
                }
            }
        } catch (error) {
            console.error(`Error resolving market ${conditionId}:`, error);
        }
    }
};

const checkAndPrintSummary = async (title: string, exitPrice?: number, conditionId?: string) => {
    const query = conditionId ? { conditionId } : { title };
    const positions = await DryRunPosition.find(query);
    if (positions.length === 0) return;

    console.log('\n==================================================');
    console.log(`📊 [DRY RUN SUMMARY] ${conditionId ? 'Market Resolved' : 'Performance Report'}`);
    console.log(`Title: ${title}`);
    if (exitPrice) {
        console.log(`Triggered by target sell @ $${exitPrice.toFixed(4)}`);
    }
    console.log('--------------------------------------------------');
    let totalSpendAll = 0;
    let totalReturnAll = 0;

    for (const p of positions) {
        // If an exitPrice is provided, we calculate potential return for current holdings
        // Otherwise use the stored totalReturn
        const currentReturn = exitPrice ? p.totalShares * exitPrice : p.totalReturn;
        const pnl = currentReturn - p.totalSpend;
        const pnlPercent = p.totalSpend > 0 ? (pnl / p.totalSpend) * 100 : 0;

        console.log(`Outcome ${p.outcome}:`);
        console.log(`  Shares Held: ${p.totalShares.toFixed(2)}`);
        console.log(`  Avg Price:   $${p.avgPrice.toFixed(4)}`);
        console.log(`  Total Spent: $${p.totalSpend.toFixed(2)}`);
        console.log(`  Current Val: $${currentReturn.toFixed(2)}`);
        console.log(`  PnL:         $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);

        totalSpendAll += p.totalSpend;
        totalReturnAll += currentReturn;
    }

    if (positions.length > 1) {
        const totalPnL = totalReturnAll - totalSpendAll;
        const totalPnLPercent = totalSpendAll > 0 ? (totalPnL / totalSpendAll) * 100 : 0;
        console.log('--------------------------------------------------');
        console.log(`TOTAL:`);
        console.log(`  Spent:       $${totalSpendAll.toFixed(2)}`);
        console.log(`  Current Val: $${totalReturnAll.toFixed(2)}`);
        console.log(`  PnL:         $${totalPnL.toFixed(2)} (${totalPnLPercent.toFixed(2)}%)`);
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

        // Periodically check for market resolution in Dry Run mode
        if (ENV.DRY_RUN && (Date.now() - lastResolveCheck > 60000)) {
            await resolveMarketPositions();
            lastResolveCheck = Date.now();
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

export default tradeExcutor;
