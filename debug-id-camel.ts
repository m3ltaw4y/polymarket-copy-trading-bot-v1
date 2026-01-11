import axios from 'axios';

async function test() {
    const conditionId = '0x8faff2f46f82e463eda4679a763893e41e3dc4982535ee3ec2ad955936ebb9e3';
    const url = `https://gamma-api.polymarket.com/markets?conditionId=${conditionId}`;
    try {
        const response = await axios.get(url);
        if (response.data && response.data.length > 0) {
            console.log("Market Data (conditionId):");
            console.log("Returned conditionId:", response.data[0].conditionId);
            console.log("Matches:", response.data[0].conditionId === conditionId);
            console.log("Question:", response.data[0].question);
        } else {
            console.log("No market found with conditionId parameter.");
        }
    } catch (e: any) {
        console.error(e.message);
    }
}

test();
