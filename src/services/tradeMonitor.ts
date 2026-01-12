import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import { tradeEventEmitter } from '../utils/eventEmitter';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;
const PROXY_WALLET = ENV.PROXY_WALLET;
const TITLE_FILTER = ENV.TITLE_FILTER;

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserPosition = getUserPositionModel(USER_ADDRESS);

let temp_trades: UserActivityInterface[] = [];

const init = async () => {
    temp_trades = (await UserActivity.find().exec()).map((trade: any) => trade as UserActivityInterface);
};

const fetchTradeData = async () => {
    try {
        const url = `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=10&type=TRADE`;
        const activities = await fetchData(url);

        if (Array.isArray(activities)) {
            const now = Math.floor(Date.now() / 1000);
            const threshold = now - (TOO_OLD_TIMESTAMP * 60);

            for (const activity of activities) {
                // Filter by timestamp
                if (activity.timestamp < threshold) {
                    continue;
                }

                const exists = await UserActivity.findOne({ transactionHash: activity.transactionHash });
                if (!exists) {
                    console.log(`Found new trade: ${activity.transactionHash}`);

                    // Apply TITLE_FILTER
                    let shouldCopy = true;
                    if (TITLE_FILTER && !activity.title.toLowerCase().includes(TITLE_FILTER.toLowerCase())) {
                        shouldCopy = false;
                        if (!ENV.LOG_ONLY_SUCCESS) {
                            console.log(`[FILTER] Skipping trade for "${activity.title}" (does not match filter)`);
                        }
                    }

                    const newTrade = new UserActivity({
                        ...activity,
                        bot: !shouldCopy, // Mark as bot: true if we shouldn't copy it
                        proxyWallet: PROXY_WALLET,
                    });
                    await newTrade.save();

                    if (shouldCopy) {
                        // Emit event to trigger executor immediately
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
    // Polling interval from ENV (default 1s)
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
