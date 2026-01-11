import axios from 'axios';

async function test() {
    const conditionId = "0x5eb6687f102f51b1522c2e788ca9f90d32f6119a6daf934cdb7419f33afd34d3";
    // Try without the condition_id filter first and search in results
    // Or try the /markets/:id endpoint if we can find the ID
    try {
        const url = `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`;
        console.log(`Fetching: ${url}`);
        const response = await axios.get(url);
        console.log(`Results: ${response.data.length}`);
        const market = response.data.find((m: any) => m.conditionId === conditionId || m.condition_id === conditionId);
        if (market) {
            console.log("Found Market:");
            console.log(JSON.stringify(market, null, 2));
        } else {
            console.log("Condition ID not found in results.");
            if (response.data.length > 0) {
                console.log("First result ID:", response.data[0].conditionId);
            }
        }
    } catch (e: any) {
        console.error(e.message);
    }
}

test();
