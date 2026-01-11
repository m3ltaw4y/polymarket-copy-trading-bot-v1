import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

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
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {
    //Merge strategy
    if (condition === 'merge') {
        if (!ENV.LOG_ONLY_SUCCESS) {
            console.log('Merging Strategy...');
        }
        if (!my_position) {
            console.log('my_position is undefined');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('No bids found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log('Max price bid:', maxPriceBid);
            }
            const currentPriceMerge = parseFloat(maxPriceBid.price);
            if (Math.abs(currentPriceMerge - trade.price) > ENV.MAX_PRICE_DIFF) {
                console.log(`Price difference too large: current ${currentPriceMerge}, target ${trade.price} (diff ${Math.abs(currentPriceMerge - trade.price).toFixed(4)} > ${ENV.MAX_PRICE_DIFF}). Skipping trade.`);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
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
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
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
        // Calculate amount based on strategy
        let calculatedAmount = 0;
        if (ENV.TRADE_EXACT) {
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
        if (calculatedAmount > MAX_TRADE_AMOUNT) {
            console.log(`Trade amount ${calculatedAmount.toFixed(2)} exceeds limits. Capping at ${MAX_TRADE_AMOUNT}`);
            calculatedAmount = MAX_TRADE_AMOUNT;
        }

        let remaining = calculatedAmount;
        // Post buy orders...
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks || orderBook.asks.length === 0) {
                console.log('No asks found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);

            console.log('Min price ask:', minPriceAsk);
            const currentPriceBuy = parseFloat(minPriceAsk.price);
            if (Math.abs(currentPriceBuy - trade.price) > ENV.MAX_PRICE_DIFF) {
                console.log(`Price difference too large: current ${currentPriceBuy}, target ${trade.price} (diff ${Math.abs(currentPriceBuy - trade.price).toFixed(4)} > ${ENV.MAX_PRICE_DIFF}). Skipping trade.`);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
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
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else if (condition === 'sell') {          //Sell strategy
        if (!ENV.LOG_ONLY_SUCCESS) {
            console.log(`Sell Strategy (Scale: ${TRADE_SCALE})...`);
        }
        let remaining = 0;
        if (!my_position) {
            console.log('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
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
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                console.log('No bids found');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            if (!ENV.LOG_ONLY_SUCCESS) {
                console.log('Max price bid:', maxPriceBid);
            }
            const currentPriceSell = parseFloat(maxPriceBid.price);
            if (Math.abs(currentPriceSell - trade.price) > ENV.MAX_PRICE_DIFF) {
                console.log(`Price difference too large: current ${currentPriceSell}, target ${trade.price} (diff ${Math.abs(currentPriceSell - trade.price).toFixed(4)} > ${ENV.MAX_PRICE_DIFF}). Skipping trade.`);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
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
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else {
        console.log('Condition not supported');
    }
};

export default postOrder;
