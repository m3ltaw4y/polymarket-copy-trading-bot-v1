import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;
const PROXY_WALLET = ENV.PROXY_WALLET;

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
                // Filter by timestamp: Only process if trade is within the allowed timeframe
                if (activity.timestamp < threshold) {
                    continue; // Skip trades that are too old
                }

                // Check if trade already exists
                const exists = await UserActivity.findOne({ transactionHash: activity.transactionHash });
                if (!exists) {
                    console.log(`Found new trade: ${activity.transactionHash}`);
                    // Map API response to our schema if necessary, or just save if it matches
                    // Assuming activity structure matches or is compatible enough for now
                    // We explicitly mark bot: false so the executor knows to copy it
                    const newTrade = new UserActivity({
                        ...activity,
                        bot: false,
                        proxyWallet: PROXY_WALLET, // Tag with our proxy wallet context if needed
                    });
                    await newTrade.save();
                }
            }
        }
    } catch (error) {
        console.error('Error in fetchTradeData:', error);
    }
};

const tradeMonitor = async () => {
    console.log('Trade Monitor is running every', FETCH_INTERVAL, 'seconds');
    await init();    //Load my oders before sever downs
    while (true) {
        await fetchTradeData();     //Fetch all user activities
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));     //Fetch user activities every second
    }
};

export default tradeMonitor;
