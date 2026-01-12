import axios from 'axios';
import { ENV } from './src/config/env';

async function testGammaActivity() {
    const user = ENV.USER_ADDRESS;
    const url = `https://gamma-api.polymarket.com/users/${user}/activity?limit=5`;
    console.log(`Testing Gamma Activity: ${url}`);
    try {
        const res = await axios.get(url);
        console.log(`Items found: ${res.data?.length || 0}`);
        if (res.data && res.data.length > 0) {
            console.log("Latest Gamma Activity Time:", res.data[0].timestamp);
            console.log(JSON.stringify(res.data[0], null, 2));
        }
    } catch (e: any) {
        console.error(`Gamma failed: ${e.message}`);
    }
}

testGammaActivity();
