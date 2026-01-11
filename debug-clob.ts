import createClobClient from './src/utils/createClobClient';
import { ENV } from './src/config/env';

async function test() {
    const clobClient = await createClobClient();
    const conditionId = "0x5eb6687f102f51b1522c2e788ca9f90d32f6119a6daf934cdb7419f33afd34d3";
    try {
        console.log(`Fetching market from CLOB: ${conditionId}`);
        const market = await clobClient.getMarket(conditionId);
        console.log(JSON.stringify(market, null, 2));
    } catch (e: any) {
        console.error("CLOB Error:", e.message);
    }
}

test();
