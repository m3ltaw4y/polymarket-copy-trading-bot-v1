import axios from 'axios';
import { ENV } from './src/config/env';

async function inspectActivity() {
    const user = ENV.USER_ADDRESS;
    const url = `https://data-api.polymarket.com/activity?user=${user}&limit=1&type=TRADE`;
    try {
        const res = await axios.get(url);
        if (res.data && res.data.length > 0) {
            console.log(JSON.stringify(res.data[0], null, 2));
        } else {
            console.log("No trades found for user.");
        }
    } catch (e: any) {
        console.error(e.message);
    }
}

inspectActivity();
