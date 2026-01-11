import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
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
        console.log('Trade to copy:', trade);

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
        const my_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );
        const user_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );
        const my_position = my_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );
        const user_position = user_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );
        const my_balance = await getMyBalance(PROXY_WALLET);
        const user_balance = await getMyBalance(USER_ADDRESS);
        console.log('My current balance:', my_balance);
        console.log('User current balance:', user_balance);
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
};

const tradeExcutor = async (clobClient: ClobClient) => {
    console.log(`Executing Copy Trading`);

    while (true) {
        await readTempTrade();
        if (temp_trades.length > 0) {
            console.log('💥 New transactions found 💥');
            spinner.stop();
            await doTrading(clobClient);
        } else {
            spinner.start('Waiting for new transactions');
        }
    }
};

export default tradeExcutor;
