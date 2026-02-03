import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';
import { DryRunPosition, DryRunTrade } from '../models/dryRun';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const TRADE_SCALE = ENV.TRADE_SCALE;
const MAX_TRADE_AMOUNT = ENV.MAX_TRADE_AMOUNT;
const UserActivity = getUserActivityModel(USER_ADDRESS);

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface & { aggregatedIds?: any[] },
    my_balance: number,
    user_balance: number
) => {
    const idsToUpdate = trade.aggregatedIds ? trade.aggregatedIds : [trade._id];

    //Merge strategy
    if (condition === 'merge') {
        if (!ENV.LOG_ONLY_SUCCESS) {
            console.log('Merging Strategy...');
        }
        if (!my_position) {
            console.log('my_position is undefined');
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
            return;
        }
        let remaining = my_position.size;
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('No bids found');
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            const currentPriceMerge = parseFloat(maxPriceBid.price);
            if (!ENV.DRY_RUN && Math.abs(currentPriceMerge - trade.price) > ENV.MAX_PRICE_DIFF) {
                console.log(`Price difference too large: current ${currentPriceMerge}, target ${trade.price} (diff ${Math.abs(currentPriceMerge - trade.price).toFixed(4)} > ${ENV.MAX_PRICE_DIFF}). Skipping trade.`);
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
                break;
            }

            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log('Order args:', order_arges);
            }
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                const priceDiff = order_arges.price - trade.price;
                const timeDiff = Math.floor(Date.now() / 1000) - trade.timestamp;
                console.log(`[SUCCESS] Merge Order placed! Price Diff: ${priceDiff > 0 ? '+' : ''}${priceDiff.toFixed(4)}, Time Diff: ${timeDiff}s`);
                console.log('Successfully posted order:', resp);
                remaining -= order_arges.amount;
            } else {
                retry += 1;
                console.log('Error posting order: retrying...', resp);
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
        }
    } else if (condition === 'buy') {       //Buy strategy
        if (!ENV.LOG_ONLY_SUCCESS) {
            console.log(`Buy Strategy (Scale: ${TRADE_SCALE})...`);
        }
        const ratio = my_balance / (user_balance + trade.usdcSize);
        if (!ENV.LOG_ONLY_SUCCESS) {
            console.log('ratio', ratio);
        }

        // Calculate raw amount
        let calculatedAmount = 0;
        if (ENV.DRY_RUN) {
            calculatedAmount = trade.usdcSize;
            console.log(`[DRY RUN] 1:1 Matching mode. Size: $${calculatedAmount.toFixed(2)}`);
        } else if (ENV.TRADE_EXACT) {
            calculatedAmount = trade.usdcSize * TRADE_SCALE;
            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log(`[EXACT MODE] Scaled trade size: $${calculatedAmount.toFixed(2)} (${trade.usdcSize} * ${TRADE_SCALE})`);
            }
        } else {
            calculatedAmount = trade.usdcSize * ratio * TRADE_SCALE;
            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log(`[SCALE MODE] Proportional size: $${calculatedAmount.toFixed(2)} (${trade.usdcSize} * ${ratio.toFixed(4)} * ${TRADE_SCALE})`);
            }
        }

        // Apply Cap
        if (!ENV.DRY_RUN && calculatedAmount > MAX_TRADE_AMOUNT) {
            console.log(`Trade amount ${calculatedAmount.toFixed(2)} exceeds limits. Capping at ${MAX_TRADE_AMOUNT}`);
            calculatedAmount = MAX_TRADE_AMOUNT;
        }

        let remaining = calculatedAmount;
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks || orderBook.asks.length === 0) {
                console.log('No asks found');
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);

            const currentPriceBuy = parseFloat(minPriceAsk.price);
            if (!ENV.DRY_RUN && Math.abs(currentPriceBuy - trade.price) > ENV.MAX_PRICE_DIFF) {
                console.log(`Price difference too large: current ${currentPriceBuy}, target ${trade.price} (diff ${Math.abs(currentPriceBuy - trade.price).toFixed(4)} > ${ENV.MAX_PRICE_DIFF}). Skipping trade.`);
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
                break;
            }

            if (ENV.DRY_RUN) {
                await simulateTrade(trade, 'BUY', remaining / currentPriceBuy, currentPriceBuy);
                break;
            }

            let order_arges;
            if (remaining <= parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price)) {
                order_arges = {
                    side: Side.BUY,
                    tokenID: trade.asset,
                    amount: remaining,
                    price: parseFloat(minPriceAsk.price),
                };
            } else {
                order_arges = {
                    side: Side.BUY,
                    tokenID: trade.asset,
                    amount: parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price),
                    price: parseFloat(minPriceAsk.price),
                };
            }
            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log('Order args:', order_arges);
            }
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                const priceDiff = order_arges.price - trade.price;
                const timeDiff = Math.floor(Date.now() / 1000) - trade.timestamp;
                console.log(`[SUCCESS] Buy Order placed! Price Diff: ${priceDiff > 0 ? '+' : ''}${priceDiff.toFixed(4)}, Time Diff: ${timeDiff}s`);
                console.log('Successfully posted order:', resp);
                remaining -= order_arges.amount;
            } else {
                retry += 1;
                console.log('Error posting order: retrying...', resp);
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
        }
    } else if (condition === 'sell') {          //Sell strategy
        if (!ENV.LOG_ONLY_SUCCESS) {
            console.log(`Sell Strategy (Scale: ${TRADE_SCALE})...`);
        }
        let remaining = 0;
        if (!my_position) {
            console.log('No position to sell');
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
            return;
        } else if (!user_position) {
            remaining = my_position.size;
        } else {
            const ratio = trade.size / (user_position.size + trade.size);
            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log('ratio', ratio);
            }
            // Apply scale but clamp to available position size
            const calculatedSell = my_position.size * ratio * TRADE_SCALE;
            remaining = Math.min(calculatedSell, my_position.size);
        }

        // Handle dry run SELL
        if (ENV.DRY_RUN) {
            const position = await DryRunPosition.findOne({ conditionId: trade.conditionId, outcome: trade.outcome });
            if (!position) {
                console.log(`[DRY RUN] No position found to sell for ${trade.outcome}`);
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
                return;
            }

            // Calculate how much to sell (1:1 matching with target)
            const sellShares = Math.min(trade.size, position.totalShares);
            const sellValue = sellShares * trade.price;

            if (sellShares > 0) {
                position.totalShares -= sellShares;
                position.totalSpend -= sellValue;

                // Update target metrics
                position.targetTotalShares -= trade.size;
                position.targetTotalSpend -= trade.usdcSize;

                // Recalculate averages
                if (position.totalShares > 0) {
                    position.avgPrice = position.totalSpend / position.totalShares;
                } else {
                    position.avgPrice = 0;
                    position.totalSpend = 0; // Fully closed
                }

                if (position.targetTotalShares > 0) {
                    position.targetAvgPrice = position.targetTotalSpend / position.targetTotalShares;
                } else {
                    position.targetAvgPrice = 0;
                    position.targetTotalSpend = 0;
                }

                await position.save();
                console.log(`[DRY RUN] SOLD ${sellShares.toFixed(2)} shares of ${trade.outcome} @ $${trade.price.toFixed(4)} (Value: $${sellValue.toFixed(2)})`);
                console.log(`[DRY RUN] Remaining: ${position.totalShares.toFixed(2)} shares (Avg: $${position.avgPrice.toFixed(4)})`);
            }

            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
            return;
        }

        // Live trading SELL logic
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
                console.log('No bids found');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            const currentPriceSell = parseFloat(maxPriceBid.price);
            if (!ENV.DRY_RUN && Math.abs(currentPriceSell - trade.price) > ENV.MAX_PRICE_DIFF) {
                console.log(`Price difference too large: current ${currentPriceSell}, target ${trade.price} (diff ${Math.abs(currentPriceSell - trade.price).toFixed(4)} > ${ENV.MAX_PRICE_DIFF}). Skipping trade.`);
                await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
                break;
            }

            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: trade.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: trade.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log('Order args:', order_arges);
            }
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                const priceDiff = order_arges.price - trade.price;
                const timeDiff = Math.floor(Date.now() / 1000) - trade.timestamp;
                console.log(`[SUCCESS] Sell Order placed! Price Diff: ${priceDiff > 0 ? '+' : ''}${priceDiff.toFixed(4)}, Time Diff: ${timeDiff}s`);
                console.log('Successfully posted order:', resp);
                remaining -= order_arges.amount;
            } else {
                retry += 1;
                console.log('Error posting order: retrying...', resp);
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
        }
    } else {
        console.log('Condition not supported');
    }
};

const simulateTrade = async (trade: UserActivityInterface & { aggregatedIds?: any[] }, side: string, size: number, price: number) => {
    const usdcSize = size * price;
    const idsToUpdate = trade.aggregatedIds ? trade.aggregatedIds : [trade._id];

    console.log(`[DRY RUN] Simulating ${side} trade for ${trade.title} (${trade.outcome}) @ ${price}. Size: ${size.toFixed(2)}, USDC: $${usdcSize.toFixed(2)}`);

    const newDryRunTrade = new DryRunTrade({
        title: trade.title,
        side: side,
        outcome: trade.outcome,
        price: price,
        size: size,
        usdcSize: usdcSize,
        targetPrice: trade.price,
        targetUsdcSize: trade.usdcSize,
        timestamp: Math.floor(Date.now() / 1000),
    });
    await newDryRunTrade.save();

    // Update DryRunPosition
    let position = await DryRunPosition.findOne({ conditionId: trade.conditionId, outcome: trade.outcome });
    if (!position) {
        position = new DryRunPosition({
            conditionId: trade.conditionId,
            title: trade.title,
            outcome: trade.outcome,
        });
    }

    if (side === 'BUY') {
        // Update Bot Metrics
        const newTotalSpend = (position.totalSpend || 0) + usdcSize;
        const newTotalShares = (position.totalShares || 0) + size;
        position.avgPrice = newTotalShares > 0 ? newTotalSpend / newTotalShares : 0;
        position.totalSpend = newTotalSpend;
        position.totalShares = newTotalShares;

        // Update Target Metrics
        const newTargetTotalSpend = (position.targetTotalSpend || 0) + trade.usdcSize;
        const newTargetTotalShares = (position.targetTotalShares || 0) + trade.size;
        position.targetAvgPrice = newTargetTotalShares > 0 ? newTargetTotalSpend / newTargetTotalShares : 0;
        position.targetTotalSpend = newTargetTotalSpend;
        position.targetTotalShares = newTargetTotalShares;
    }

    await position.save();

    // Update largest market position if needed
    const { DryRunStats } = await import('../models/dryRunStats');
    const allPositionsInMarket = await DryRunPosition.find({ conditionId: trade.conditionId });
    const totalMarketSpend = allPositionsInMarket.reduce((sum, p) => sum + (p.targetTotalSpend || 0), 0);

    let stats = await DryRunStats.findOne();
    if (!stats) {
        stats = new DryRunStats();
    }

    if (totalMarketSpend > (stats.largestMarketSpend || 0)) {
        stats.largestMarketSpend = totalMarketSpend;
        stats.largestMarketTitle = trade.title;
        await stats.save();
    }

    // Mark activity as processed
    await UserActivity.updateMany({ _id: { $in: idsToUpdate } }, { bot: true });
};

export default postOrder;
