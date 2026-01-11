import axios from 'axios';

async function test() {
    const conditionId = '0x8faff2f46f82e463eda4679a763893e41e3dc4982535ee3ec2ad955936ebb9e3';
    const url = `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`;
    try {
        const response = await axios.get(url);
        console.log("Market Data for 0x8faff...:");
        console.log(JSON.stringify(response.data, null, 2));
    } catch (e: any) {
        console.error(e.message);
    }
}

test();
