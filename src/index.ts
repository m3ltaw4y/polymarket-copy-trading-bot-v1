import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor from './services/tradeExecutor';
import tradeMonitor from './services/tradeMonitor';
import test from './test/test';
import getMyBalance from './utils/getMyBalance';
import moment from 'moment';
import fetchData from './utils/fetchData';
import { DryRunPosition, DryRunTrade } from './models/dryRun';
import { runHistoricalAnalysis } from './algo/analyzer';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
const TRADE_SCALE = ENV.TRADE_SCALE;

export const main = async () => {
    // Check for ALGO_ANALYZE mode
    if (ENV.ALGO_ANALYZE) {
        await connectDB();
        await runHistoricalAnalysis();
        process.exit(0);
    }

    await connectDB();
    console.log(`Target User Wallet addresss is: ${USER_ADDRESS}`);
    console.log(`My Wallet addresss is: ${PROXY_WALLET}`);

    // Fetch and log balances
    let ratio = 0;
    if (!ENV.DRY_RUN) {
        try {
            const targetBalance = await getMyBalance(USER_ADDRESS);
            const myBalance = await getMyBalance(PROXY_WALLET);
            console.log('--------------------------------------------------');
            console.log(`Target User Balance: ${targetBalance} USDC`);
            console.log(`My Wallet Balance:   ${myBalance} USDC`);

            if (targetBalance > 0) {
                ratio = myBalance / targetBalance;
                console.log(`Trading Ratio:       ${ratio.toFixed(4)}`);
                console.log(`Trade Scale:         ${TRADE_SCALE.toFixed(2)}x`);
                console.log(`Max Trade Amount:    $${ENV.MAX_TRADE_AMOUNT.toFixed(2)}`);
                console.log(`Title Filter:        ${ENV.TITLE_FILTER || 'NONE'}`);
                console.log(`Exact Match Mode:    ${ENV.TRADE_EXACT ? 'ON' : 'OFF'}`);
                console.log(`Dry Run Mode:        OFF`);
                console.log(`Effective Multiplier: ${(ratio * TRADE_SCALE).toFixed(4)}`);
            } else {
                console.log(`Trading Ratio:       N/A (Target balance is 0)`);
            }
            console.log('--------------------------------------------------');
        } catch (error) {
            console.error('Failed to fetch initial balances:', error);
        }
    } else {
        console.log('--------------------------------------------------');
        console.log(`Dry Run Mode:        ON`);
        console.log(`Trade Scale:         ${TRADE_SCALE.toFixed(2)}x`);
        console.log(`Max Trade Amount:    $${ENV.MAX_TRADE_AMOUNT.toFixed(2)}`);
        console.log(`Title Filter:        ${ENV.TITLE_FILTER || 'NONE'}`);
        console.log(`Exact Match Mode:    ${ENV.TRADE_EXACT ? 'ON' : 'OFF'}`);
        console.log(`Balances:            SKIPPED (Dry Run)`);

        // Clear dry run data on startup if RESET_ON_RUN is enabled
        if (ENV.RESET_ON_RUN) {
            try {
                const { DryRunStats } = await import('./models/dryRunStats');
                await DryRunTrade.deleteMany({});
                await DryRunPosition.deleteMany({});
                await DryRunStats.deleteMany({});
                console.log(`Dry Run Data:        CLEARED (RESET_ON_RUN=1)`);
            } catch (e) {
                console.error('Failed to clear dry run data:', e);
            }
        } else {
            console.log(`Dry Run Data:        PERSISTED (set RESET_ON_RUN=1 to clear)`);
        }

        console.log('--------------------------------------------------');
        ratio = 1;
    }

    // Fetch and log recent target activity
    console.log('Fetching recent target activity...');
    try {
        const url = `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=5&type=TRADE`;
        const activities = await fetchData(url);

        if (Array.isArray(activities) && activities.length > 0) {
            const today = moment().startOf('day');
            const recentTrades = activities.filter((activity: any) => moment(activity.timestamp * 1000).isSameOrAfter(today));

            console.log('--------------------------------------------------');
            console.log(`Recent Target Activity (Today: ${today.format('YYYY-MM-DD')})`);

            if (recentTrades.length === 0) {
                console.log('No trades found for today.');
            } else {
                recentTrades.forEach((trade: any) => {
                    const time = moment(trade.timestamp * 1000).format('HH:mm:ss');
                    let myEst = "";
                    if (ENV.DRY_RUN) {
                        const myCost = trade.usdcSize;
                        const mySize = (myCost / trade.price).toFixed(2);
                        myEst = ` | [DRY RUN] Est: ${mySize} shares (~$${myCost.toFixed(2)})`;
                    } else if (ratio > 0) {
                        // Estimate my share size and cost
                        let rawCost = 0;
                        if (ENV.TRADE_EXACT) {
                            rawCost = trade.usdcSize * TRADE_SCALE;
                        } else {
                            rawCost = trade.usdcSize * ratio * TRADE_SCALE;
                        }

                        let myCost = rawCost;
                        let cappedMsg = "";
                        if (rawCost > ENV.MAX_TRADE_AMOUNT) {
                            myCost = ENV.MAX_TRADE_AMOUNT;
                            cappedMsg = " (CAPPED)";
                        }
                        const mySize = (myCost / trade.price).toFixed(2);
                        myEst = ` | My Est: ${mySize} shares (~$${myCost.toFixed(2)}${cappedMsg})`;
                    }
                    console.log(`[${time}] ${trade.side} ${trade.size} ${trade.asset} @ ${trade.price}${myEst}`);
                });
            }
            console.log('--------------------------------------------------');
        }
    } catch (error) {
        console.error('Failed to fetch recent activity:', error);
    }

    const clobClient = await createClobClient();
    tradeMonitor();  //Monitor target user's transactions
    tradeExecutor(clobClient);  //Execute transactions on your wallet
    // test(clobClient);
};

main();
