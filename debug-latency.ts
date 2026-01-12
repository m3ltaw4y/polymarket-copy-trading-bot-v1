import axios from 'axios';
import { ENV } from './src/config/env';

async function testLatency() {
    const user = ENV.USER_ADDRESS;
    console.log(`Testing latency for user: ${user}`);

    const dataUrl = `https://data-api.polymarket.com/activity?user=${user}&limit=5&type=TRADE`;
    const clobUrl = `https://clob.polymarket.com/activity?user=${user}&limit=5&type=TRADE`;

    console.time('Data API');
    try {
        const res = await axios.get(dataUrl);
        console.timeEnd('Data API');
        if (res.data && res.data.length > 0) {
            console.log(`Latest Data API Trade: ${res.data[0].timestamp} (${new Date(res.data[0].timestamp * 1000).toISOString()})`);
        }
    } catch (e: any) {
        console.log(`Data API failed: ${e.message}`);
    }

    // Note: I'm not sure if this endpoint exists, let's check
    console.time('CLOB API (guess)');
    try {
        const res = await axios.get(clobUrl);
        console.timeEnd('CLOB API (guess)');
        if (res.data && res.data.length > 0) {
            console.log(`Latest CLOB API Trade: ${res.data[0].timestamp}`);
        }
    } catch (e: any) {
        console.log(`CLOB API (guess) failed: ${e.message}`);
    }

    // Check Gamma API
    const gammaUrl = `https://gamma-api.polymarket.com/events?user=${user}&limit=5`;
    console.time('Gamma API');
    try {
        const res = await axios.get(gammaUrl);
        console.timeEnd('Gamma API');
        if (res.data && res.data.length > 0) {
            console.log(`Latest Gamma API Event: ${res.data[0].timestamp}`);
        }
    } catch (e: any) {
        console.log(`Gamma API failed: ${e.message}`);
    }
}

testLatency();
