import axios from 'axios';
import { ENV } from './src/config/env';

async function compareAPIs() {
    const user = ENV.USER_ADDRESS;
    const dataUrl = `https://data-api.polymarket.com/activity?user=${user}&limit=5&type=TRADE`;
    const gammaUrl = `https://gamma-api.polymarket.com/activity?user=${user}&limit=5&type=TRADE`;

    console.log("Comparing Data API vs Gamma API...");

    try {
        const dRes = await axios.get(dataUrl);
        console.log("Data API Latest:", dRes.data[0]?.timestamp);
    } catch (e: any) { console.log("Data API failed"); }

    try {
        const gRes = await axios.get(gammaUrl);
        console.log("Gamma API Latest:", gRes.data[0]?.timestamp);
    } catch (e: any) { console.log("Gamma API failed"); }
}

compareAPIs();
