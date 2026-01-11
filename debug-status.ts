import axios from 'axios';

async function test() {
    const conditionId = "0x5eb6687f102f51b1522c2e788ca9f90d32f6119a6daf934cdb7419f33afd34d3";
    const url = `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`;
    try {
        const response = await axios.get(url);
        console.log(`Results for ${conditionId}:`);
        response.data.forEach((m: any) => {
            console.log(`- Title: ${m.question}`);
            console.log(`  ID: ${m.conditionId}`);
            console.log(`  Closed: ${m.closed}`);
            console.log(`  Active: ${m.active}`);
            console.log(`  Disputed: ${m.disputed}`);
            console.log(`  End Date: ${m.end_date_iso || m.endDate}`);
            console.log(`  Accepting Orders: ${m.accepting_orders}`);
            console.log(`  Outcome Prices: ${m.outcomePrices}`);
        });
    } catch (e: any) {
        console.error(e.message);
    }
}

test();
