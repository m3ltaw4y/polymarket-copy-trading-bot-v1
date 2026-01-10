import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor from './services/tradeExecutor';
import tradeMonitor from './services/tradeMonitor';
import test from './test/test';
import getMyBalance from './utils/getMyBalance';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;

export const main = async () => {
    await connectDB();
    console.log(`Target User Wallet addresss is: ${USER_ADDRESS}`);
    console.log(`My Wallet addresss is: ${PROXY_WALLET}`);

    // Fetch and log balances
    try {
        const targetBalance = await getMyBalance(USER_ADDRESS);
        const myBalance = await getMyBalance(PROXY_WALLET);
        console.log('--------------------------------------------------');
        console.log(`Target User Balance: ${targetBalance} USDC`);
        console.log(`My Wallet Balance:   ${myBalance} USDC`);

        if (targetBalance > 0) {
            console.log(`Trading Ratio:       ${(myBalance / targetBalance).toFixed(4)}`);
        } else {
            console.log(`Trading Ratio:       N/A (Target balance is 0)`);
        }
        console.log('--------------------------------------------------');
    } catch (error) {
        console.error('Failed to fetch initial balances:', error);
    }

    const clobClient = await createClobClient();
    tradeMonitor();  //Monitor target user's transactions
    tradeExecutor(clobClient);  //Execute transactions on your wallet
    // test(clobClient);
};

main();
